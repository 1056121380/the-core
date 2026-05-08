import type {
  MemoryRecord,
  MemoryType,
  MessageRecord,
  SelectedMemoryDebugItem
} from '@shared/types'
import { getMemoryLayer } from '@shared/constants'

export interface MemorySelectionInput {
  memories: MemoryRecord[]
  recentMessages: MessageRecord[]
  sessionId: string
  query?: string
}

export interface MemorySelectionResult {
  all: MemoryRecord[]
  recentSummaries: MemoryRecord[]
  proactiveSummaries: MemoryRecord[]
  projectFacts: MemoryRecord[]
  projectGoals: MemoryRecord[]
  userFacts: MemoryRecord[]
  userPreferences: MemoryRecord[]
  styleRules: MemoryRecord[]
  tasks: MemoryRecord[]
  debugItems: SelectedMemoryDebugItem[]
  queryTokens: string[]
  /** IDs of memories that should be expressed with uncertainty (low confidence). */
  fuzzyMemoryIds: number[]
}

interface RankedMemory {
  memory: MemoryRecord
  score: number
}

const TYPE_LIMITS: Record<MemoryType, number> = {
  recent_summary: 2,
  proactive_summary: 2,
  project_fact: 3,
  project_goal: 2,
  user_fact: 2,
  user_preference: 3,
  style_rule: 3,
  task: 4
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function tokenize(text: string): string[] {
  const asciiTokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)

  const compact = text.replace(/\s+/g, '')
  const chineseTokens: string[] = []

  for (let size = 2; size <= 6; size += 1) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      const token = compact.slice(index, index + size)
      if (/^[\u4e00-\u9fff]+$/.test(token)) {
        chineseTokens.push(token)
      }
    }
  }

  return unique([...asciiTokens, ...chineseTokens]).slice(0, 120)
}

function hoursSince(isoText: string): number {
  return Math.max(0, (Date.now() - new Date(isoText).getTime()) / (60 * 60 * 1000))
}

function getTypeBaseScore(type: MemoryType): number {
  switch (type) {
    case 'recent_summary':
      return 28
    case 'project_goal':
      return 22
    case 'task':
      return 24
    case 'proactive_summary':
      return 21
    case 'project_fact':
      return 20
    case 'user_preference':
      return 18
    case 'style_rule':
      return 16
    case 'user_fact':
      return 14
    default:
      return 10
  }
}

function scoreMemory(memory: MemoryRecord, tokens: string[], sessionId: string): number {
  let score = getTypeBaseScore(memory.type)
  score += memory.weight * 35
  score += (memory.metadata?.confidence ?? 0.55) * 6
  score += Math.min(memory.metadata?.hitCount ?? 0, 8) * 1.2
  const layer = getMemoryLayer(memory.type)

  if (layer === 'persona') {
    score += 8
  } else if (layer === 'short_term') {
    score += 5
  } else {
    score += 2
  }

  if (memory.sessionId === sessionId) {
    score += 12
  } else if (!memory.sessionId) {
    score += 6
  }

  const recencyHours = hoursSince(memory.updatedAt)
  score += Math.max(0, 10 - recencyHours / 24)
  if (memory.metadata?.lastHitAt) {
    const hitRecencyHours = hoursSince(memory.metadata.lastHitAt)
    score += Math.max(0, 5 - hitRecencyHours / 48)
  }

  const normalizedContent = memory.content.toLowerCase()
  let overlap = 0
  for (const token of tokens) {
    if (token.length >= 2 && normalizedContent.includes(token.toLowerCase())) {
      overlap += token.length >= 4 ? 6 : 3
    }
  }

  return score + Math.min(overlap, 26)
}

function rankByType(
  memories: MemoryRecord[],
  sessionId: string,
  tokens: string[],
  type: MemoryType
): RankedMemory[] {
  const limit = TYPE_LIMITS[type]
  return memories
    .filter((memory) => memory.type === type && (!memory.sessionId || memory.sessionId === sessionId))
    .map((memory) => ({ memory, score: scoreMemory(memory, tokens, sessionId) }))
    .sort((left, right) => right.score - left.score || right.memory.weight - left.memory.weight)
    .slice(0, limit)
}

function toDebugItems(items: RankedMemory[]): SelectedMemoryDebugItem[] {
  return items.map(({ memory, score }) => ({
    memoryId: memory.id,
    type: memory.type,
    layer: getMemoryLayer(memory.type),
    content: memory.content,
    weight: memory.weight,
    isPinned: memory.isPinned,
    score: Number(score.toFixed(2)),
    sessionId: memory.sessionId,
    source: memory.source,
    confidence: memory.metadata?.confidence ?? null,
    hitCount: memory.metadata?.hitCount ?? 0,
    lastHitAt: memory.metadata?.lastHitAt ?? null
  }))
}

export function selectMemories(input: MemorySelectionInput): MemorySelectionResult {
  const contextText = [
    input.query ?? '',
    ...input.recentMessages
      .slice(-8)
      .map((message) => (message.segments.length > 0 ? message.segments.join(' ') : message.content))
  ].join('\n')

  const tokens = tokenize(contextText)
  const recentSummaryRanked = rankByType(input.memories, input.sessionId, tokens, 'recent_summary')
  const proactiveSummaryRanked = rankByType(input.memories, input.sessionId, tokens, 'proactive_summary')
  const projectFactRanked = rankByType(input.memories, input.sessionId, tokens, 'project_fact')
  const projectGoalRanked = rankByType(input.memories, input.sessionId, tokens, 'project_goal')
  const userFactRanked = rankByType(input.memories, input.sessionId, tokens, 'user_fact')
  const userPreferenceRanked = rankByType(input.memories, input.sessionId, tokens, 'user_preference')
  const styleRuleRanked = rankByType(input.memories, input.sessionId, tokens, 'style_rule')
  const taskRanked = rankByType(input.memories, input.sessionId, tokens, 'task')

  const ranked = [
    ...recentSummaryRanked,
    ...proactiveSummaryRanked,
    ...projectFactRanked,
    ...projectGoalRanked,
    ...userFactRanked,
    ...userPreferenceRanked,
    ...styleRuleRanked,
    ...taskRanked
  ].sort((left, right) => right.score - left.score)

  // Humanization: occasionally mark some memories as "fuzzy" to simulate imperfect recall.
  // Memories with low confidence or low hit count have a chance of being uncertain.
  // This makes the AI feel less like a perfect database and more like a human remembering things.
  const fuzzyMemoryIds: number[] = []
  for (const item of ranked) {
    const confidence = item.memory.metadata?.confidence ?? 0.55
    const hitCount = item.memory.metadata?.hitCount ?? 0
    const isLowConfidence = confidence < 0.5
    const isRarelyRecalled = hitCount <= 1
    const randomFuzz = Math.random() < 0.12 // ~12% chance per memory
    if ((isLowConfidence && randomFuzz) || (isRarelyRecalled && isLowConfidence && randomFuzz)) {
      fuzzyMemoryIds.push(item.memory.id)
    }
  }

  return {
    all: ranked.map((item) => item.memory),
    recentSummaries: recentSummaryRanked.map((item) => item.memory),
    proactiveSummaries: proactiveSummaryRanked.map((item) => item.memory),
    projectFacts: projectFactRanked.map((item) => item.memory),
    projectGoals: projectGoalRanked.map((item) => item.memory),
    userFacts: userFactRanked.map((item) => item.memory),
    userPreferences: userPreferenceRanked.map((item) => item.memory),
    styleRules: styleRuleRanked.map((item) => item.memory),
    tasks: taskRanked.map((item) => item.memory),
    debugItems: toDebugItems(ranked),
    queryTokens: tokens,
    fuzzyMemoryIds
  }
}
