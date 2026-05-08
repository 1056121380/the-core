// ============================================================
// LLMFeedbackJudge - 大模型情感判断服务
// 让大模型判断用户消息对各项指标的影响
// 替代传统的规则判断，更加自然和智能
// ============================================================

import type { MessageRecord, EmotionState } from '@shared/types'
import { createChatCompletion, shouldUseLiveLlm } from '@main/services/llmClient'
import type { SettingsRecord } from '@shared/types'
import { logger } from '@main/services/logger'

export interface LLMFeedbackJudgeInput {
  userMessage: string
  recentMessages: MessageRecord[]
  intimacyScore: number
  lastInteractionAt: string | null
}

export interface LLMFeedbackJudgeResult {
  intimacyDelta: number      // -5 到 +3 之间，亲密度变化
  emotionShift: EmotionState // 情绪变化
  motivationDelta: number     // -10 到 +10，动机变化（影响主动聊天意愿）
  engagementLevel: number     // 0-100，用户参与度
  shouldAutoReply: boolean   // 是否需要主动缓和/回应
  topicAvoidance: string[]   // 近期要回避的话题
  reason: string             // 判断理由（用于日志，不暴露给用户）
}

function clip(text: string, max = 100): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

export async function judgeUserFeedback(
  input: LLMFeedbackJudgeInput,
  settings: SettingsRecord
): Promise<LLMFeedbackJudgeResult> {
  if (!shouldUseLiveLlm(settings)) {
    return defaultResult()
  }

  const recent = input.recentMessages.slice(-6)
  const recentText = recent
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${clip(m.segments.join(' ') || m.content, 80)}`)
    .join('\n')

  const hoursSinceLastInteraction = input.lastInteractionAt
    ? Math.round((Date.now() - new Date(input.lastInteractionAt).getTime()) / (60 * 60 * 1000))
    : null

  const prompt = [
    '你是情感分析专家。请分析用户最新一条消息，判断它对对话氛围的影响。',
    '',
    '分析维度：',
    '1. intimacy_delta: 亲密度变化，范围 -5 到 +3',
    '   - 负面情绪(烦躁/冷漠/拒绝) → -3 到 -5',
    '   - 中性消息(嗯/好/随便) → -1 到 0',
    '   - 正面情绪(感谢/认同/分享) → +1 到 +3',
    '   - 如果用户长时间没回复(>24h)再回复，即使中性也 +1（用户还记得你）',
    '',
    '2. emotion_shift: 用户当前情绪状态',
    '   - warm: 积极友好',
    '   - steady: 正常中性',
    '   - concerned: 有些冷淡或不耐烦',
    '   - drained: 明显负面或疲惫',
    '',
    '3. motivation_delta: 用户参与动机变化，范围 -10 到 +10',
    '   - 负面 → -5 到 -10',
    '   - 中性 → -2 到 +2',
    '   - 正面 → +3 到 +10',
    '',
    '4. engagement_level: 用户当前参与度 0-100',
    '   - 积极回复/提问 → 70-100',
    '   - 正常回复 → 40-70',
    '   - 冷淡回复/已读不回趋势 → 10-40',
    '',
    '5. should_auto_reply: 是否需要助手主动说些什么来缓和气氛',
    '   - 用户明显不耐烦/烦躁 → true',
    '   - 用户正常 → false',
    '',
    '6. topic_avoidance: 用户不想聊的话题数组',
    '   - 用户明确表示不感兴趣的 → ["游戏", "某话题"]',
    '   - 没有要回避的 → []',
    '',
    '7. reason: 分析理由，用于日志记录，不要暴露给用户',
    '',
    '输出格式（严格JSON，不要markdown）：',
    '{"intimacy_delta": 数字, "emotion_shift": "warm|steady|concerned|drained", "motivation_delta": 数字, "engagement_level": 数字, "should_auto_reply": true|false, "topic_avoidance": ["话题"], "reason": "理由"}',
    '',
    `用户最新消息: ${input.userMessage}`,
    recentText ? `最近对话:\n${recentText}` : '',
    hoursSinceLastInteraction !== null ? `距离上次互动: ${hoursSinceLastInteraction}小时` : ''
  ].filter(Boolean).join('\n')

  try {
    const raw = await createChatCompletion(
      {
        systemPrompt: '你是情感分析专家，输出严格JSON格式。',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      },
      settings
    )

    const parsed = JSON.parse(raw)
    logger.info('feedback', 'LLM feedback judgment.', {
      userMessage: clip(input.userMessage, 30),
      result: parsed
    })

    return {
      intimacyDelta: clampDelta(parsed.intimacy_delta, -5, 3),
      emotionShift: parseEmotionShift(parsed.emotion_shift),
      motivationDelta: clampDelta(parsed.motivation_delta, -10, 10),
      engagementLevel: clamp(parsed.engagement_level ?? 50, 0, 100),
      shouldAutoReply: Boolean(parsed.should_auto_reply),
      topicAvoidance: Array.isArray(parsed.topic_avoidance) ? parsed.topic_avoidance : [],
      reason: String(parsed.reason ?? '')
    }
  } catch (error) {
    logger.warn('feedback', 'LLM feedback judgment failed, using default.', { error: String(error) })
    return defaultResult()
  }
}

function defaultResult(): LLMFeedbackJudgeResult {
  return {
    intimacyDelta: 0,
    emotionShift: 'steady',
    motivationDelta: 0,
    engagementLevel: 50,
    shouldAutoReply: false,
    topicAvoidance: [],
    reason: 'default'
  }
}

function clampDelta(value: unknown, min: number, max: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(min, Math.min(max, Math.round(num)))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function parseEmotionShift(value: unknown): EmotionState {
  if (value === 'warm') return 'warm'
  if (value === 'concerned') return 'concerned'
  if (value === 'drained') return 'drained'
  return 'steady'
}

// ============================================================
// EngagementContext - 影响因子计算
// 根据用户状态动态调整主动聊天策略
// ============================================================

export interface EngagementContext {
  engagementLevel: number      // 用户参与度 0-100
  motivationLevel: number      // 用户动机 0-100
  topicAvoidance: string[]     // 要回避的话题
  lastInteractionHours: number // 距离上次互动小时数
  recentRejections: number     // 近期被拒绝次数
}

export interface ProactiveModifier {
  // 主动聊天欲望调节
  desireMultiplier: number     // 乘数，<1降低欲望，>1增强欲望
  preferredTopics: string[]   // 更可能聊的话题
  avoidedTopics: string[]     // 要回避的话题
  urgencyLevel: 'low' | 'normal' | 'high'  // 紧急程度
  suggestedTone: 'gentle' | 'normal' | 'playful'  // 建议语气
  skipReason: string | null   // 如果不该主动，说明原因
}

export function calculateProactiveModifier(context: EngagementContext): ProactiveModifier {
  const {
    engagementLevel,
    motivationLevel,
    topicAvoidance,
    lastInteractionHours,
    recentRejections
  } = context

  // 默认值
  let desireMultiplier = 1.0
  let urgencyLevel: 'low' | 'normal' | 'high' = 'normal'
  let suggestedTone: 'gentle' | 'normal' | 'playful' = 'normal'
  let skipReason: string | null = null
  let preferredTopics: string[] = []
  const avoidedTopics = [...topicAvoidance]

  // 参与度很低且很久没互动 → 降低欲望
  if (engagementLevel < 30 && lastInteractionHours > 48) {
    desireMultiplier = 0.5
    skipReason = '用户参与度低且久未互动，降低打扰'
  }

  // 用户动机很低 → 不要太主动
  if (motivationLevel < 30) {
    desireMultiplier *= 0.6
    suggestedTone = 'gentle'
    urgencyLevel = 'low'
  }

  // 用户最近多次拒绝 → 显著降低欲望
  if (recentRejections >= 2) {
    desireMultiplier *= 0.4
    suggestedTone = 'gentle'
    skipReason = skipReason ?? '用户近期多次拒绝，主动频率降至最低'
  }

  // 用户积极参与 → 可以稍微多聊
  if (engagementLevel > 70 && motivationLevel > 60) {
    desireMultiplier *= 1.2
    suggestedTone = 'playful'
  }

  // 很久没互动（>72小时）→ 稍微提高主动欲望
  if (lastInteractionHours > 72 && engagementLevel > 40) {
    desireMultiplier *= 1.3
    urgencyLevel = 'normal'
  }

  // 太久没互动（>168小时/一周）→ 但用户没回来过
  if (lastInteractionHours > 168 && engagementLevel < 20) {
    desireMultiplier = 0.2
    skipReason = skipReason ?? '用户超过一周未互动，可能暂时离开'
  }

  return {
    desireMultiplier: Math.max(0.1, Math.min(2.0, desireMultiplier)),
    preferredTopics,
    avoidedTopics,
    urgencyLevel,
    suggestedTone,
    skipReason
  }
}
