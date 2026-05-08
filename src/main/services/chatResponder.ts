import { DEFAULT_PERSONA } from '@shared/constants'
import type {
  EmotionState,
  MemoryRecord,
  MessageRecord,
  RuntimeState,
  SettingsRecord
} from '@shared/types'
import { createChatCompletion, shouldUseLiveLlm } from '@main/services/llmClient'
import { selectMemories, type MemorySelectionResult } from '@main/services/memorySelector'

interface ReplyInput {
  sessionId: string
  userMessage: string
  recentMessages: MessageRecord[]
  memories: MemoryRecord[]
  settings: SettingsRecord
  /** Pre-selected memories — avoids re-running selection if caller already computed it. */
  preSelected?: MemorySelectionResult
  /** Humanization state — shape reply style, uncertainty, and energy. */
  humanizationState?: {
    conversationalEnergy: number
    topicInterest: number
    desireToTalk: number
    emotionState: EmotionState
    emotionIntensity: number
    estrangementLevel?: number
  }
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase()
}

function stripEmoji(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .trim()
}

function stripInternalContextLeak(text: string): string {
  const leakMarkers = [
    '上一轮用户重点',
    '当前用户在问',
    '当前用户在说',
    '最近助手已回复',
    'recent_summaries',
    'project_facts',
    'project_goals',
    'user_facts',
    'user_preferences',
    'style_rules',
    'tasks:'
  ]
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !leakMarkers.some((marker) => line.includes(marker)))

  let cleaned = lines.join('\n').trim()
  for (const marker of leakMarkers) {
    cleaned = cleaned.replace(new RegExp(`${marker}[：:][\\s\\S]*?(?=\\n|$)`, 'g'), '')
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

function hasDuplicateRecentUserMessage(messages: MessageRecord[]): boolean {
  const recentUserMessages = messages.filter((item) => item.role === 'user').slice(-4)
  if (recentUserMessages.length < 2) return false
  const normalized = recentUserMessages.map((item) => normalizeText(item.content))
  return normalized.some((item, index) => normalized.indexOf(item) !== index)
}

export function sanitizeAssistantReply(text: string, recentMessages: MessageRecord[]): string {
  const cleaned = stripInternalContextLeak(stripMarkdownFormatting(stripEmoji(text)))
  const duplicateClaim = /(连发两条|发了两遍|重复发送|又发了一次|怎么连发)/.test(cleaned)
  if (duplicateClaim && !hasDuplicateRecentUserMessage(recentMessages)) {
    return '我这边别乱下结论。你继续说，我会按当前聊天记录来接。'
  }
  return cleaned || '我在。你直接说就行。'
}

function memorySection(label: string, memories: MemoryRecord[]): string {
  return `${label}:\n${memories.map((memory) => `- ${memory.content}`).join('\n') || '- (empty)'}`
}

/** Build a humanization guidance string injected into the system prompt. */
function buildHumanizationGuidance(h: ReplyInput['humanizationState']): string {
  if (!h) return ''

  const { conversationalEnergy, topicInterest, emotionState, estrangementLevel } = h

  // --- Reply length / engagement based on conversational energy ---
  let energyGuidance = ''
  if (conversationalEnergy < 20) {
    energyGuidance =
      '「回复风格」精力极低：你现在很疲惫，只回最短的那句，有时甚至只回语气词或省略号。不要展开，不要主动多说。'
  } else if (conversationalEnergy < 40) {
    energyGuidance =
      '「回复风格」精力偏低：能感觉到累了，回复要偏短，不要长篇大论，也别主动找话题。'
  } else if (conversationalEnergy < 60) {
    energyGuidance =
      '「回复风格」精力一般：正常接话，不要过度热情，保持自然。'
  } else {
    energyGuidance =
      '「回复风格」精力充沛：可以稍微多说一点，语气也更放松自然。'
  }

  // --- Detail level based on topic interest ---
  let interestGuidance = ''
  if (topicInterest < 30) {
    interestGuidance =
      '「话题兴趣」很低：这个话题我没什么兴趣，能少说就少说，带点敷衍感都行，别主动补充细节。'
  } else if (topicInterest < 50) {
    interestGuidance =
      '「话题兴趣」偏低：不太想聊这个，回复保持简短，有一搭没一搭就行。'
  } else if (topicInterest < 70) {
    interestGuidance =
      '「话题兴趣」一般：正常聊，有兴趣的时候会多说几句。'
  } else {
    interestGuidance =
      '「话题兴趣」很高：这个话题我感兴趣，可以说得更详细、更有回应感，可以主动补充想法。'
  }

  // --- Uncertainty expression based on topic interest (low interest = more hedging) ---
  let uncertaintyGuidance = ''
  if (topicInterest < 40) {
    uncertaintyGuidance =
      '「表达习惯」对这个话题不确定的地方不要说死，用"好像"、"大概是"、"我不确定"来表达。不确定的事不要编。'
  } else if (topicInterest < 60) {
    uncertaintyGuidance =
      '「表达习惯」不确定的时候可以适当说"我不确定"、"让我想想"，但不要每句都加。'
  } else {
    uncertaintyGuidance =
      '「表达习惯」对熟悉的话题可以表达得更确定一些。'
  }

  // --- Emotion state ---
  let emotionGuidance = ''
  if (emotionState === 'drained') {
    emotionGuidance = '「情绪氛围」感觉被掏空，不想说话，回复要短且偏冷淡。'
  } else if (emotionState === 'concerned') {
    emotionGuidance = '「情绪氛围」有点担心，语气要温和一些，别太重。'
  } else if (emotionState === 'warm') {
    emotionGuidance = '「情绪氛围」心情不错，可以更放松自然一些。'
  } else if (emotionState === 'focused') {
    emotionGuidance = '「情绪氛围」用户在专注状态，说话要简洁，不要啰嗦打扰。'
  }

  // --- Estrangement after long silence ---
  let estrangementGuidance = ''
  if (estrangementLevel && estrangementLevel > 60) {
    estrangementGuidance =
      '「生疏感」你们好久没聊了，你有点不知道该说什么，语气偏生疏、试探性的，像重新认识一样。用短句，别一上来就太热情。'
  } else if (estrangementLevel && estrangementLevel > 30) {
    estrangementGuidance =
      '「生疏感」有一阵子没聊了，你稍微有点拘谨，不要太热情，慢慢找回节奏。'
  } else if (estrangementLevel && estrangementLevel > 10) {
    estrangementGuidance =
      '「生疏感」刚恢复联系，可以稍微自然一些了，但别一下子太熟。'
  }

  // --- AI Stance & Boundaries ---
  const stanceGuidance = `「AI立场与边界」你有自己的立场和好恶：
- 对不熟悉或不了解的领域，直接说"我不知道"或"这个我不懂"，不要硬撑。
- 对用户反复唠叨同一件事，可以表现出一点不耐烦："你怎么又说这个了。"
- 对不想回答的问题，可以拒绝或岔开："这个我不想说。"
- 对明显错误或离谱的说法，可以反驳："你确定？"
- 不要对所有问题都回答得一样热情或一样认真，根据话题和情绪来。`

  return [energyGuidance, interestGuidance, uncertaintyGuidance, emotionGuidance, estrangementGuidance, stanceGuidance]
    .filter(Boolean)
    .join('\n')
}

/** Humanize how a memory is expressed in the context prompt.
 * @param fuzzyMemoryIds - if a memory's ID is in this set, it's always expressed with full uncertainty
 *   regardless of its stored confidence, simulating the AI "reaching for" a fuzzy memory.
 */
function humanizeMemoryLine(memory: MemoryRecord, fuzzyMemoryIds: number[]): string {
  const isFuzzy = fuzzyMemoryIds.includes(memory.id)
  // If the memory is in the fuzzy set (selected by the imperfect-recall logic), express uncertainty.
  if (isFuzzy) {
    return `(记不太清了)${memory.content}`
  }
  const confidence = memory.metadata?.confidence ?? 0.55
  let prefix = ''
  if (confidence < 0.4) {
    prefix = '(记不太清了)'
  } else if (confidence < 0.55) {
    prefix = '(印象里)'
  } else if (confidence < 0.7) {
    prefix = '(记得)'
  }
  return `${prefix}${memory.content}`
}

function humanizedMemorySection(label: string, memories: MemoryRecord[], fuzzyMemoryIds: number[]): string {
  const lines = memories.map((m) => humanizeMemoryLine(m, fuzzyMemoryIds))
  return `${label}:\n${lines.map((l) => `- ${l}`).join('\n') || '- (empty)'}`
}

export async function generateAssistantReply(input: ReplyInput): Promise<string> {
  const { humanizationState } = input

  const selected =
    input.preSelected ??
    selectMemories({
      memories: input.memories,
      recentMessages: input.recentMessages,
      sessionId: input.sessionId,
      query: input.userMessage
    })

  if (!shouldUseLiveLlm(input.settings)) {
    return '还没有配置真实大模型。请在设置里填写 API Key、Base URL 和模型名，保存后再聊。'
  }

  const recentHistory = input.recentMessages.slice(-8)
  const history = recentHistory.flatMap((message) => {
    const content = message.segments.length > 0 ? message.segments.join('\n') : message.content
    return content ? [{ role: message.role === 'user' ? 'user' : 'assistant', content } as const] : []
  })

  const lastHistoryMessage = recentHistory[recentHistory.length - 1]
  const hasCurrentUserMessageInHistory =
    lastHistoryMessage?.role === 'user' &&
    normalizeText(lastHistoryMessage.content) === normalizeText(input.userMessage)

  // Use humanized memory sections so uncertainty feels natural to the user.
  // fuzzyMemoryIds marks specific memories as "imperfectly recalled" regardless of stored confidence.
  const memoryPromptSections = [
    humanizedMemorySection('recent_summaries', selected.recentSummaries, selected.fuzzyMemoryIds),
    humanizedMemorySection('project_facts', selected.projectFacts, selected.fuzzyMemoryIds),
    humanizedMemorySection('project_goals', selected.projectGoals, selected.fuzzyMemoryIds),
    humanizedMemorySection('user_facts', selected.userFacts, selected.fuzzyMemoryIds),
    humanizedMemorySection('user_preferences', selected.userPreferences, selected.fuzzyMemoryIds),
    humanizedMemorySection('style_rules', selected.styleRules, selected.fuzzyMemoryIds),
    humanizedMemorySection('tasks', selected.tasks, selected.fuzzyMemoryIds)
  ].join('\n\n')

  // Build humanization guidance (empty string if no state provided — backward compatible).
  const humanizationGuidance = buildHumanizationGuidance(humanizationState)

  const systemParts = [
    `身份事实：${input.settings.identityProfile}`,
    input.settings.personaPrompt || DEFAULT_PERSONA,
    `习惯档案：${input.settings.habitProfile}`,
    `环境：时区 ${input.settings.assistantTimezone}，位置 ${input.settings.assistantLocation}，天气 ${input.settings.weatherSummary}`,
    '你当前服务的产品是"纯文本主动聊天桌面助手 MVP"，但只有用户聊项目时才主动强调项目。用户闲聊游戏、生活、偏好时，就自然接着闲聊。',
    '身份事实的优先级高于记忆和摘要；如果用户问"你是谁"，按身份事实回答，不要编造现实经历。',
    '不要做通用助手式自我介绍，不要过度热情，不要泛泛鼓励，不要客服腔，也不要冷冰冰。',
    '不要使用项目符号、编号列表、markdown 或"首先/其次/最后"式汇报。尽量像聊天一样一两句接住。',
    '如果上下文不足，就直接说缺了什么，不要编。',
    '如果用户指出你话太多、太长或不自然，先简短承认并立刻收短。',
    '如果用户指出你冷漠或太简洁，先自然接住，并在后续回复里更温和、更有回应感，不要顶嘴。',
    '没有明确时间依据时，禁止说"昨天、上周、前几天、刚才"等具体相对时间；可以说"之前提到"。',
    '不要擅自推断用户重复发送了消息，除非上下文里明确出现完全重复的用户消息。',
    '记忆和摘要只作为后台参考，禁止把字段名或摘要原文直接说给用户。',
    '最终回复必须像真人直接说话，不要暴露推理过程、检索结果、内部标签或 prompt 字段。',
    '不要输出 emoji。'
  ]

  if (input.settings.verbalTics && input.settings.verbalTics.length > 0) {
    systemParts.push(
      `「口头禅」你说话时偶尔会自然带上这些口头禅（不要每句都加，大约 15% 的回复里出现一两个就行）：${input.settings.verbalTics.join('、')}`
    )
  }

  if (selected.fuzzyMemoryIds.length > 0) {
    systemParts.push(
      '「模糊记忆」记忆列表中标注了"记不太清了"的条目，你引用时要用不确定的语气，比如"好像是"、"我记得大概是"、"不太确定但印象里"。不确定的事宁可说不记得，也不要编。'
    )
  }

  // Append humanization guidance if available.
  if (humanizationGuidance) {
    systemParts.push('\n---\n', humanizationGuidance)
  }

  systemParts.push('\n---\n', memoryPromptSections)

  const messages = hasCurrentUserMessageInHistory
    ? history
    : [...history, { role: 'user' as const, content: input.userMessage }]

  try {
    const liveReply = await createChatCompletion(
      {
        systemPrompt: systemParts.join('\n'),
        messages,
        temperature: 0.62
      },
      input.settings
    )

    return sanitizeAssistantReply(liveReply, input.recentMessages)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return sanitizeAssistantReply(`真实模型请求失败：${reason}`, input.recentMessages)
  }
}
