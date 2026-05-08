import type { AppRepository } from '@main/repositories/database'
import { createChatCompletion, shouldUseLiveLlm } from '@main/services/llmClient'
import { logger } from '@main/services/logger'
import { MemoryCandidateArraySchema } from '@shared/schema'
import { getMemoryLayer } from '@shared/constants'
import type {
  MemoryRecord,
  MemorySummaryMode,
  MemoryType,
  MessageRecord,
  SettingsRecord
} from '@shared/types'

interface MaintainMemoryInput {
  repository: AppRepository
  sessionId: string
  settings: SettingsRecord
}

interface ImportantMemoryCandidate {
  type: MemoryType
  content: string
  weight: number
  shouldStore: boolean
  deadline?: string
}

export interface MemoryMaintenanceResult {
  summaryMode: MemorySummaryMode
  summaryContent: string | null
  summaryUpdatedAt: string | null
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function clip(text: string, max = 72): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function sanitizeText(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function toMessageLine(message: MessageRecord): string {
  const content = message.segments.length > 0 ? message.segments.join(' ') : message.content
  return clip(content, 100)
}

function buildHeuristicSummary(messages: MessageRecord[]): string | null {
  const recent = messages.slice(-8)
  const userMessages = recent.filter((message) => message.role === 'user')
  const assistantMessages = recent.filter((message) => message.role === 'assistant')
  const latestUser = userMessages[userMessages.length - 1]
  const previousUser = userMessages[userMessages.length - 2]
  const latestAssistant = assistantMessages[assistantMessages.length - 1]

  if (!latestUser && !latestAssistant) return null

  const lines: string[] = []
  if (previousUser) lines.push(`上一轮用户重点：${toMessageLine(previousUser)}。`)
  if (latestUser) lines.push(`当前用户在说：${toMessageLine(latestUser)}。`)
  if (latestAssistant) lines.push(`最近助手已回复：${toMessageLine(latestAssistant)}。`)
  return clip(lines.join(' '), 240)
}

async function buildLlmSummary(messages: MessageRecord[], settings: SettingsRecord): Promise<string | null> {
  if (!shouldUseLiveLlm(settings) || messages.length === 0) return null

  const transcript = messages
    .slice(-10)
    .map((message) => `${message.role}: ${clip(message.segments.join(' ') || message.content, 160)}`)
    .join('\n')

  try {
    const raw = await createChatCompletion(
      {
        systemPrompt:
          '你是短期记忆压缩器。把最近对话压缩成 2 到 4 句中文事实摘要，只保留用户目标、当前问题、明确偏好、已决定事项。不要寒暄，不要编号，不要 markdown，不要编造。',
        messages: [{ role: 'user', content: `请压缩这段最近对话：\n${transcript}` }],
        temperature: 0.2
      },
      settings
    )
    const cleaned = sanitizeText(raw)
    return cleaned ? clip(cleaned, 240) : null
  } catch (error) {
    logger.warn('memory', 'LLM summary failed; falling back to heuristic summary.', {
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

function parseJsonArray(raw: string): unknown[] {
  const cleaned = raw.trim()
  const direct = cleaned.match(/\[[\s\S]*\]/)
  return JSON.parse(direct ? direct[0] : cleaned) as unknown[]
}

function clampWeight(weight: number, fallback = 0.72): number {
  if (!Number.isFinite(weight)) return fallback
  return Math.max(0.2, Math.min(1, Number(weight.toFixed(2))))
}

function parseRelativeDeadline(text: string): string | null {
  const now = new Date()
  const next = new Date(now)
  if (text.includes('今天') || text.includes('今晚')) {
    next.setHours(20, 0, 0, 0)
    return next.toISOString()
  }
  if (text.includes('明天')) {
    next.setDate(now.getDate() + 1)
    next.setHours(18, 0, 0, 0)
    return next.toISOString()
  }
  if (text.includes('后天')) {
    next.setDate(now.getDate() + 2)
    next.setHours(18, 0, 0, 0)
    return next.toISOString()
  }
  if (text.includes('本周')) {
    const day = next.getDay() || 7
    next.setDate(now.getDate() + (7 - day))
    next.setHours(18, 0, 0, 0)
    return next.toISOString()
  }
  return null
}

function canonicalizeCandidate(candidate: ImportantMemoryCandidate): ImportantMemoryCandidate | null {
  const text = sanitizeText(candidate.content)
  if (!text || text.length < 6) return null

  if (
    /知识库|截止日期|周树人|鲁迅|我是桌面助手|处理日常事务|项目文档里|你能做什么|不要自我介绍|按这个项目上下文回答/.test(
      text
    )
  ) {
    return null
  }

  if (/不要.*简洁|不要.*冷漠|说话.*冷漠|太冷漠|更温暖|有温度|不要那么简洁/.test(text)) {
    return {
      ...candidate,
      type: 'style_rule',
      content: '用户希望助手说话更温暖、更有回应感，不要过度简洁冷漠。',
      weight: Math.max(candidate.weight, 0.86),
      shouldStore: true
    }
  }

  if (/魂类|souls|法环|艾尔登|黑暗之魂|黑魂|只狼|血源/.test(text)) {
    if (/玩过|通关|体验过/.test(text)) {
      return {
        ...candidate,
        type: 'user_fact',
        content: '用户玩过艾尔登法环、黑暗之魂3和只狼。',
        weight: Math.max(candidate.weight, 0.82),
        shouldStore: true
      }
    }
    return {
      ...candidate,
      type: 'user_preference',
      content: '用户喜欢魂类游戏。',
      weight: Math.max(candidate.weight, 0.86),
      shouldStore: true
    }
  }

  if (/记忆系统|记忆文件|JSON|局部.*清理|全部.*清理|可编辑/.test(text)) {
    if (/局部.*清理|全部.*清理|清理按钮/.test(text)) {
      return {
        ...candidate,
        type: 'style_rule',
        content: '记忆管理 UI 需要保留局部清理和全部清理按钮。',
        weight: Math.max(candidate.weight, 0.86),
        shouldStore: true
      }
    }
    return {
      ...candidate,
      type: 'user_preference',
      content: '用户重视记忆系统的可编辑性，希望记忆文件使用 JSON 存储。',
      weight: Math.max(candidate.weight, 0.86),
      shouldStore: true
    }
  }

  return { ...candidate, content: text }
}

function similarMemoryKey(memory: Pick<MemoryRecord, 'type' | 'content' | 'sessionId'> | ImportantMemoryCandidate): string {
  const content = normalizeText(memory.content).replace(/[，。！？；：,.!?;:]/g, '')
  if (/温暖|冷漠|简洁|有回应感/.test(content)) return `${memory.type}::style:warmth`
  if (/记忆系统|记忆文件|json|可编辑|局部清理|全部清理/.test(content)) return `${memory.type}::memory:editability`
  if (/魂类|souls|艾尔登|法环|黑魂|只狼|血源/.test(content)) return `${memory.type}::game:souls`
  return `${memory.type}::${content.slice(0, 80)}`
}

async function llmCandidatesFromMessages(
  messages: MessageRecord[],
  settings: SettingsRecord
): Promise<ImportantMemoryCandidate[]> {
  if (!settings.memoryAutoStoreEnabled || !shouldUseLiveLlm(settings) || messages.length === 0) return []

  const transcript = messages
    .slice(-10)
    .map((message) => `${message.role}: ${clip(message.segments.join(' ') || message.content, 200)}`)
    .join('\n')

  try {
    const raw = await createChatCompletion(
      {
        systemPrompt: [
          '你是长期记忆评审器。你的任务不是总结所有聊天，而是判断哪些信息值得长期保存。',
          '只保存对未来回复明显有用、稳定、可复用的信息。普通寒暄、一次性情绪、模型自己的回答、临时吐槽、无依据身份事实都不要保存。',
          '可用类型只有 project_fact, project_goal, user_fact, user_preference, style_rule, task。',
          '权重含义：0.50 临时有点用，0.72 值得保存，0.85 高价值稳定记忆，0.95 核心事实。',
          '如果不值得保存，返回空数组。',
          '只输出 JSON 数组，每项格式为 {"type":"...","content":"...","weight":0.0-1.0,"shouldStore":true/false,"deadline":"optional"}。'
        ].join(' '),
        messages: [{ role: 'user', content: `请评审这段对话中是否有值得长期保存的记忆：\n${transcript}` }],
        temperature: 0.1
      },
      settings
    )

    const parsed = parseJsonArray(raw)
    const result = MemoryCandidateArraySchema.safeParse(parsed)
    if (!result.success) return []

    return result.data
      .map((item) => ({
        type: item.type,
        content: sanitizeText(item.content),
        weight: clampWeight(item.weight),
        shouldStore: item.shouldStore,
        deadline: item.deadline
      }))
      .filter((item) => item.content.length >= 6)
      .slice(0, 4)
  } catch (error) {
    logger.warn('memory', 'LLM memory extraction failed.', {
      error: error instanceof Error ? error.message : String(error)
    })
    return []
  }
}

function highConfidenceRuleCandidates(messages: MessageRecord[]): ImportantMemoryCandidate[] {
  const candidates: ImportantMemoryCandidate[] = []
  const userTexts = messages
    .filter((message) => message.role === 'user')
    .slice(-10)
    .map((message) => sanitizeText(message.segments.join(' ') || message.content))

  for (const text of userTexts) {
    if (text.length < 8) continue

    if (/我(希望|不喜欢|喜欢|更喜欢|讨厌|偏好)|不要.*说|以后.*记住/.test(text)) {
      candidates.push({
        type: /语气|说话|分段|短句|客服腔|热情|冷漠/.test(text) ? 'style_rule' : 'user_preference',
        content: text,
        weight: 0.76,
        shouldStore: true
      })
    }

    if (/我(现在|正在|主要|打算).*项目|当前项目|项目目标|MVP|主线/.test(text)) {
      candidates.push({
        type: /目标|先做|优先|主线/.test(text) ? 'project_goal' : 'project_fact',
        content: text,
        weight: 0.76,
        shouldStore: true
      })
    }

    if (/今天|明天|后天|本周|今晚|截止|完成|做完|交付|上线|收口/.test(text)) {
      candidates.push({
        type: 'task',
        content: text,
        weight: parseRelativeDeadline(text) ? 0.84 : 0.72,
        shouldStore: true,
        deadline: parseRelativeDeadline(text) ?? undefined
      })
    }
  }

  return candidates
}

async function extractImportantMemories(
  repository: AppRepository,
  sessionId: string,
  settings: SettingsRecord,
  messages: MessageRecord[]
): Promise<void> {
  if (!settings.memoryAutoStoreEnabled) {
    logger.info('memory', 'Automatic long-term memory storage is disabled.', { sessionId })
    return
  }

  const llmCandidates = await llmCandidatesFromMessages(messages, settings)
  const ruleCandidates = shouldUseLiveLlm(settings) ? [] : highConfidenceRuleCandidates(messages)
  const threshold = Math.max(0.5, Math.min(0.95, settings.memoryImportanceThreshold))
  const merged = [...llmCandidates, ...ruleCandidates]
    .map(canonicalizeCandidate)
    .filter((candidate): candidate is ImportantMemoryCandidate => Boolean(candidate))
    .filter((candidate) => candidate.shouldStore && candidate.weight >= threshold)

  logger.info('memory', 'Evaluated long-term memory candidates.', {
    sessionId,
    threshold,
    llmCandidateCount: llmCandidates.length,
    fallbackRuleCandidateCount: ruleCandidates.length,
    acceptedCount: merged.length,
    accepted: merged.map((item) => ({
      type: item.type,
      content: clip(item.content, 60),
      weight: item.weight,
      deadline: item.deadline ?? null
    }))
  })

  if (merged.length === 0) return

  const deduped = new Map<string, ImportantMemoryCandidate>()
  for (const candidate of merged) {
    const key = `${similarMemoryKey(candidate)}::${candidate.deadline ?? ''}`
    const previous = deduped.get(key)
    if (!previous || candidate.weight > previous.weight) deduped.set(key, candidate)
  }

  const globalMemories = await repository.listMemories({
    sessionId,
    includeGlobal: true,
    types: ['project_fact', 'project_goal', 'user_fact', 'user_preference', 'style_rule', 'task']
  })

  for (const candidate of deduped.values()) {
    const existing = globalMemories.find(
      (memory) =>
        memory.type === candidate.type &&
        memory.sessionId === null &&
        similarMemoryKey(memory) === similarMemoryKey(candidate) &&
        (memory.type !== 'task' || (memory.metadata?.deadline ?? null) === (candidate.deadline ?? null))
    )

    if (existing) {
      const nextWeight = clampWeight(Math.max(existing.weight, candidate.weight) + 0.04, existing.weight)
      await repository.updateMemory(existing.id, {
        content: candidate.content,
        weight: nextWeight,
        source: existing.source === 'system_seed' ? existing.source : 'maintenance',
        metadata: {
          ...(existing.metadata ?? {}),
          memoryLayer: getMemoryLayer(existing.type),
          importanceReason: existing.metadata?.importanceReason ?? '自动评审通过的长期记忆',
          deadline: existing.type === 'task' ? candidate.deadline ?? existing.metadata?.deadline ?? null : existing.metadata?.deadline ?? null,
          taskStatus: existing.type === 'task' ? existing.metadata?.taskStatus ?? 'open' : existing.metadata?.taskStatus
        }
      })
      continue
    }

    const created = await repository.addMemory({
      type: candidate.type,
      content: candidate.content,
      weight: candidate.weight,
      isPinned: false,
      sessionId: null,
      source: 'maintenance',
      metadata: {
        memoryLayer: getMemoryLayer(candidate.type),
        importanceReason: '自动评审通过的长期记忆',
        deadline: candidate.type === 'task' ? candidate.deadline ?? null : null,
        taskStatus: candidate.type === 'task' ? 'open' : undefined
      }
    })

    logger.info('memory', 'Created long-term memory.', {
      sessionId,
      memoryId: created.id,
      type: created.type,
      content: clip(created.content, 80),
      weight: created.weight
    })
  }
}

function mergeDuplicateMemories(memories: MemoryRecord[]): { keepIds: Set<number>; deleteIds: number[] } {
  const groups = new Map<string, MemoryRecord[]>()

  for (const memory of memories) {
    const key = `${memory.sessionId ?? 'global'}::${similarMemoryKey(memory)}::${
      memory.type === 'task' ? memory.metadata?.deadline ?? '' : ''
    }`
    const bucket = groups.get(key) ?? []
    bucket.push(memory)
    groups.set(key, bucket)
  }

  const keepIds = new Set<number>()
  const deleteIds: number[] = []
  for (const bucket of groups.values()) {
    bucket.sort((left, right) => {
      if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1
      if (right.weight !== left.weight) return right.weight - left.weight
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    })
    keepIds.add(bucket[0].id)
    for (const duplicate of bucket.slice(1)) deleteIds.push(duplicate.id)
  }

  return { keepIds, deleteIds }
}

function getDecayTarget(memory: MemoryRecord): number {
  if (memory.isPinned || memory.source === 'system_seed') return memory.weight

  const ageHours = Math.max(0, (Date.now() - new Date(memory.updatedAt).getTime()) / (60 * 60 * 1000))
  const ageDays = ageHours / 24

  if (memory.type === 'recent_summary' || memory.source === 'chat_summary') {
    return Math.max(0.12, memory.weight - ageDays * 0.035)
  }
  if (memory.type === 'proactive_summary') return Math.max(0.18, memory.weight - ageDays * 0.03)
  if (memory.type === 'task') return Math.max(0.42, memory.weight - ageDays * 0.01)
  if (memory.source === 'maintenance') return Math.max(0.18, memory.weight - ageDays * 0.02)
  return Math.max(0.2, memory.weight - ageDays * 0.008)
}

function shouldPrune(memory: MemoryRecord): boolean {
  if (memory.isPinned || memory.type === 'task' || memory.type === 'proactive_summary') return false
  const ageHours = Math.max(0, (Date.now() - new Date(memory.updatedAt).getTime()) / (60 * 60 * 1000))
  const isChatDerived = memory.type === 'recent_summary' || memory.source === 'chat_summary'
  return isChatDerived && ageHours > 24 * 10 && memory.weight <= 0.18
}

export async function maintainMemories(input: MaintainMemoryInput): Promise<MemoryMaintenanceResult> {
  const recentMessages = await input.repository.listMessages(input.sessionId, 20)
  const llmSummary = await buildLlmSummary(recentMessages, input.settings)
  const heuristicSummary = llmSummary ? null : buildHeuristicSummary(recentMessages)
  const summary = llmSummary ?? heuristicSummary
  const summaryMode: MemorySummaryMode = llmSummary ? 'llm' : heuristicSummary ? 'heuristic' : 'none'

  let summaryRecord: MemoryRecord | null = null
  if (summary) {
    summaryRecord = await input.repository.upsertRecentSummary({
      sessionId: input.sessionId,
      content: summary,
      weight: recentMessages.length >= 6 ? 0.82 : 0.7
    })
  }

  await extractImportantMemories(input.repository, input.sessionId, input.settings, recentMessages)

  const memories = await input.repository.listMemories({
    sessionId: input.sessionId,
    includeGlobal: true
  })

  const { keepIds, deleteIds } = mergeDuplicateMemories(memories)
  if (deleteIds.length > 0) await input.repository.deleteMemories(deleteIds)

  for (const memory of memories) {
    if (!keepIds.has(memory.id)) continue
    const nextWeight = Number(getDecayTarget(memory).toFixed(3))
    if (Math.abs(nextWeight - memory.weight) >= 0.01) {
      await input.repository.updateMemory(memory.id, { weight: nextWeight })
    }
  }

  const freshMemories = await input.repository.listMemories({
    sessionId: input.sessionId,
    includeGlobal: true
  })
  const pruneIds = freshMemories.filter(shouldPrune).map((memory) => memory.id)
  if (pruneIds.length > 0) await input.repository.deleteMemories(pruneIds)

  return {
    summaryMode,
    summaryContent: summaryRecord?.content ?? summary ?? null,
    summaryUpdatedAt: summaryRecord?.updatedAt ?? summaryRecord?.createdAt ?? null
  }
}
