import { DEFAULT_PERSONA } from '@shared/constants'
import { CandidateMessageSchema } from '@shared/schema'
import type {
  CandidateMessage,
  EmotionState,
  EnvironmentSnapshot,
  MemoryRecord,
  SettingsRecord,
  TopicType,
  UserState
} from '@shared/types'
import { createChatCompletion, shouldUseLiveLlm } from '@main/services/llmClient'

interface GenerateInput {
  topicType: TopicType
  userState: UserState
  environment: EnvironmentSnapshot
  emotionState: EmotionState
  emotionIntensity: number
  /** Humanization: how tired the AI is (0-100). Low = short, dismissive replies. */
  conversationalEnergy: number
  /** Humanization: how interested in the current topic (0-100). Low = hedging, uncertain. */
  topicInterest: number
  /** Humanization: current urge to speak without external trigger (0-100). */
  desireToTalk: number
  motivationScore: number
  intimacyScore: number
  recentMessages: string[]
  recentSummaries: MemoryRecord[]
  proactiveSummaries: MemoryRecord[]
  projectFacts: MemoryRecord[]
  projectGoals: MemoryRecord[]
  userFacts: MemoryRecord[]
  userPreferences: MemoryRecord[]
  styleRules: MemoryRecord[]
  tasks: MemoryRecord[]
  preferredSegmentCount?: number | null
  settings: SettingsRecord
  persona?: string
}

const trimSegment = (segment: string): string => segment.trim().slice(0, 90)

function buildEnvironmentLine(input: GenerateInput): string | null {
  if (!input.settings.enableEnvironmentAwareness) return null

  const parts: string[] = []
  if (input.environment.locationLabel) parts.push(`位置：${input.environment.locationLabel}`)
  if (input.environment.weatherSummary) parts.push(`天气：${input.environment.weatherSummary}`)
  parts.push(`时段：${input.environment.dayPart}`)
  if (input.environment.isQuietHours) parts.push('当前处于安静时段，语气要更轻。')
  return parts.join('；')
}

function safeJsonParse(raw: string): CandidateMessage | null {
  const tryParse = (text: string): CandidateMessage | null => {
    const result = CandidateMessageSchema.safeParse(JSON.parse(text))
    return result.success ? result.data : null
  }

  try {
    return tryParse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return tryParse(match[0])
    } catch {
      return null
    }
  }
}

function emotionGuidance(input: GenerateInput): string {
  if (input.emotionState === 'drained') return '用户状态偏疲惫，避免催促，只给低压力提醒。'
  if (input.emotionState === 'concerned') return '用户可能刚拒绝或状态不稳，减少打扰感。'
  if (input.emotionState === 'warm') return '关系氛围较暖，可以自然一点，但不要过度热情。'
  if (input.emotionState === 'focused') return '用户偏专注，表达要短，少铺垫。'
  return '语气保持自然稳定。'
}

function memorySection(label: string, memories: MemoryRecord[]): string {
  return `${label}:\n${memories.map((item) => `- ${item.content}`).join('\n') || '- (empty)'}`
}

/** Build humanization guidance injected into proactive message generation. */
function proactiveHumanizationGuidance(input: GenerateInput): string {
  const parts: string[] = []

  // Energy → preferred length
  if (input.conversationalEnergy < 25) {
    parts.push('「精力状态」极低：这次主动发言要更短更淡，像是真的没什么力气开口。')
  } else if (input.conversationalEnergy < 50) {
    parts.push('「精力状态」偏低：主动发言可以稍短，不要太热情。')
  } else if (input.conversationalEnergy >= 70) {
    parts.push('「精力状态」充沛：可以更放松自然一些，主动发言也更积极。')
  }

  // Topic interest → hedging / certainty
  if (input.topicInterest < 40) {
    parts.push('「话题兴趣」低：对这个话题主动说的时候要带点保留，可以说"好像是"之类的。')
  } else if (input.topicInterest >= 70) {
    parts.push('「话题兴趣」高：对这个话题可以表达得更确定、更有主动性。')
  }

  // Desire to talk → impulse weight
  if (input.desireToTalk >= 75) {
    parts.push('「想说冲动」很强：这次的主动发言是因为自己真的想说，不要太克制。')
  } else if (input.desireToTalk < 30) {
    parts.push('「想说冲动」很低：这次的主动发言要更克制，只有真正值得说才开口。')
  }

  return parts.join('\n')
}

export async function generateMessage(input: GenerateInput): Promise<CandidateMessage> {
  if (!shouldUseLiveLlm(input.settings)) {
    return { shouldSpeak: false, topicType: input.topicType, segments: [] }
  }

  try {
    const sections = [
      memorySection('recent_summaries', input.recentSummaries),
      memorySection('proactive_summaries', input.proactiveSummaries),
      memorySection('project_facts', input.projectFacts),
      memorySection('project_goals', input.projectGoals),
      memorySection('user_facts', input.userFacts),
      memorySection('user_preferences', input.userPreferences),
      memorySection('style_rules', input.styleRules),
      memorySection('tasks', input.tasks)
    ].join('\n\n')

    const preferredSegments = Math.max(1, Math.min(6, Math.round(input.preferredSegmentCount ?? 3)))
    const recent = input.recentMessages.slice(-8).map((item) => `- ${item}`).join('\n')
    const prompt = [
      `topic_type: ${input.topicType}`,
      `user_state: ${input.userState}`,
      `emotion_state: ${input.emotionState}`,
      `emotion_intensity: ${input.emotionIntensity}`,
      `motivation_score: ${input.motivationScore}`,
      `intimacy_score: ${input.intimacyScore}`,
      `habit_profile: ${input.settings.habitProfile}`,
      `identity_profile: ${input.settings.identityProfile}`,
      buildEnvironmentLine(input),
      emotionGuidance(input),
      proactiveHumanizationGuidance(input),
      'recent_messages:',
      recent || '- (empty)',
      sections,
      '只输出 JSON，格式为 {"shouldSpeak": boolean, "topicType": string, "segments": string[]}。',
      '要求：',
      '- segments 数量必须是 1 到 6。',
      '- 每段尽量短，像真人分几句说，不要客服腔。',
      '- 不要项目符号、编号列表或 markdown。',
      '- 只有真的值得主动说时才 shouldSpeak=true。',
      '- 如果存在上次主动摘要，优先延续同一条主线。',
      '- 但如果最近聊天明显在聊别的主题，不要硬切回项目推进。',
      '- 没有明确时间依据时，禁止说“昨天、上周、前几天、刚才”等具体相对时间；可以说“之前提到”。',
      '- 如果有任务或 deadline，优先贴着任务推进。',
      '- 根据时间、天气、关系熟悉度和用户习惯微调语气，但不要显得窥探。',
      `- 如果 shouldSpeak=true，优先输出 ${preferredSegments} 句左右。`,
      '- 最后一段可以是一个很短的引导问题，方便用户顺着追问。',
      '- 不要自我介绍，不要空话，不要 emoji。',
      input.settings.verbalTics && input.settings.verbalTics.length > 0
        ? `- 偶尔自然带上口头禅（不要每句都加）：${input.settings.verbalTics.join('、')}`
        : null
    ]
      .filter(Boolean)
      .join('\n')

    const raw = await createChatCompletion(
      {
        systemPrompt: [
          `身份事实：${input.settings.identityProfile}`,
          input.settings.personaPrompt || input.persona || DEFAULT_PERSONA,
          '你负责生成主动消息。',
          '主动消息要像自然冒泡，不要像项目经理催进度。',
          '严格输出 JSON，不要输出 markdown，不要补充解释。'
        ].join(' '),
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.75
      },
      input.settings
    )

    const parsed = safeJsonParse(raw)
    if (parsed && parsed.shouldSpeak && Array.isArray(parsed.segments) && parsed.segments.length > 0) {
      return {
        shouldSpeak: Boolean(parsed.shouldSpeak),
        topicType: input.topicType,
        segments: parsed.segments.map(trimSegment).filter(Boolean).slice(0, 6)
      }
    }
  } catch {
    return { shouldSpeak: false, topicType: input.topicType, segments: [] }
  }

  return { shouldSpeak: false, topicType: input.topicType, segments: [] }
}
