/**
 * Shared helper functions for the proactive system.
 * These utilities are used by both scoring.ts and topicSelector.ts
 * to keep logic consistent and avoid duplication.
 */

import type { MemoryRecord, MessageRecord } from '@shared/types'

/**
 * Extract recent conversation text from message history.
 * Used for topic-mismatch detection and casual/project classification.
 */
export function getRecentConversationText(recentMessages: MessageRecord[]): string {
  return recentMessages
    .slice(-8)
    .map((message) => (message.segments.length > 0 ? message.segments.join(' ') : message.content))
    .join(' ')
}

/**
 * Check if the conversation is project/technical in nature.
 * Used to distinguish between work talk and casual chat.
 */
export function isProjectLike(text: string): boolean {
  return /项目|MVP|主动|触发|冷却|记忆|桌面助手|代码|测试|模块|架构|设置|debug|score|prompt|LLM|API/i.test(text)
}

/**
 * Check if the conversation is casual/personal in nature.
 * Used to detect when the AI should not push work topics.
 */
export function isCasualTopic(text: string): boolean {
  return /游戏|魂类|法环|艾尔登|只狼|黑魂|血源|装甲核心|黑神话|推荐|玩过|喜欢玩|电影|音乐|吃|睡|哈哈/.test(text)
}

export interface DigressionOptions {
  intimacyScore: number
  conversationalEnergy: number
  availableMemories: MemoryRecord[]
  usedMemoryIds: number[]
}

const DIGRESSION_OPENERS = ['哦对了突然想到，', '话说我刚想起来，', '诶等等，', '突然想到一个事，']
const DIGRESSION_CLOSERS = ['算了不说这个了，', '扯远了，', '回来回来，']

export function injectDigression(segments: string[], options: DigressionOptions): string[] {
  if (segments.length < 2) return segments
  if (options.intimacyScore < 45 || options.conversationalEnergy < 50) return segments
  if (Math.random() > 0.06) return segments

  const unusedMemories = options.availableMemories.filter(
    (m) =>
      !options.usedMemoryIds.includes(m.id) &&
      (m.type === 'user_fact' || m.type === 'user_preference') &&
      m.content.length > 4 &&
      m.content.length < 40
  )

  if (unusedMemories.length === 0) return segments

  const memory = unusedMemories[Math.floor(Math.random() * unusedMemories.length)]
  const opener = DIGRESSION_OPENERS[Math.floor(Math.random() * DIGRESSION_OPENERS.length)]
  const closer = DIGRESSION_CLOSERS[Math.floor(Math.random() * DIGRESSION_CLOSERS.length)]

  const tangent = opener + memory.content
  const insertPos = Math.floor(segments.length / 2)

  const result = [...segments]
  result.splice(insertPos, 0, tangent, closer)
  return result
}
