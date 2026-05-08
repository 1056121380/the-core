// ============================================================
// RelationshipEngine - 数字人关系引擎
// 负责管理用户关系：亲密度、信任度、熟悉度
// 整合了 scoring.ts 和 feedbackLearner.ts 的核心逻辑
// ============================================================

import type {
  RelationshipScore,
  RelationshipState,
  ProactiveContext
} from '@main/types/digitalHuman'
import type { EmotionState, FeedbackType, TopicType } from '@shared/types'
import type { AppRepository } from '@main/repositories/database'

const CLAMP = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

// --- 评分计算 ---
interface ScoreBreakdown {
  name: string
  value: number
}

interface ScoreResult {
  score: number
  breakdown: ScoreBreakdown[]
}

function getWeightedTypeBonus(context: Pick<ProactiveContext, 'memories'>): number {
  const projectMemories = context.memories.filter(
    (m) => m.type === 'project_fact' || m.type === 'project_goal'
  )
  const total = projectMemories.reduce((sum, m) => sum + m.weight, 0)
  return CLAMP(Math.round(total * 6), 0, 12)
}

function getRecentSummaryBonus(context: Pick<ProactiveContext, 'memories'>): number {
  const recentSummary = context.memories.find((m) => m.type === 'recent_summary')
  if (!recentSummary) return 0
  const ageMinutes = (Date.now() - new Date(recentSummary.updatedAt).getTime()) / (60 * 1000)
  if (ageMinutes <= 60) return 6
  if (ageMinutes <= 240) return 4
  if (ageMinutes <= 720) return 2
  return 0
}

function getSoonTaskScore(tasks: Array<{ metadata?: { deadline?: string; taskStatus?: string } }>, now: Date): number {
  const openTasks = tasks.filter((m) => (m.metadata?.taskStatus ?? 'open') === 'open')
  let score = 0
  for (const task of openTasks) {
    const deadline = task.metadata?.deadline
    if (!deadline) continue
    const diffHours = (new Date(deadline).getTime() - now.getTime()) / (60 * 60 * 1000)
    if (diffHours <= 0) score = Math.max(score, 26)
    else if (diffHours <= 24) score = Math.max(score, 20)
    else if (diffHours <= 72) score = Math.max(score, 10)
  }
  return score
}

function getWeatherAdjustment(summary: string): number {
  if (!summary || summary.includes('默认不主动引用天气')) return 0
  if (/(storm|heavy rain|台风|暴雨|雷雨|闷热|酷热|大风)/.test(summary)) return 5
  if (/(clear|sunny|晴|舒适|凉爽)/.test(summary)) return 2
  return 0
}

function isProjectLike(text: string): boolean {
  return /项目|MVP|主动|触发|冷却|记忆|桌面助手|代码|测试|模块|架构|设置|debug|score|prompt|LLM|API/i.test(text)
}

function isCasualTopic(text: string): boolean {
  return /游戏|魂类|法环|艾尔登|只狼|黑魂|血源|装甲核心|黑神话|推荐|玩过|喜欢玩|电影|音乐|吃|睡|哈哈/.test(text)
}

function getHourScore(histogram: number[] | undefined, hour: number): number {
  if (!histogram || histogram.length === 0) return 0
  const peak = Math.max(...histogram, 0)
  if (peak <= 0) return 0
  return histogram[hour] / peak
}

// --- 关系状态计算 ---
function computeRelationshipState(
  current: RelationshipScore,
  interactionDelta: Partial<RelationshipScore>,
  feedbackType?: FeedbackType
): RelationshipScore {
  const next = { ...current }
  if (interactionDelta.intimacy) next.intimacy = CLAMP(next.intimacy + interactionDelta.intimacy, 0, 100)
  if (interactionDelta.trust) next.trust = CLAMP(next.trust + interactionDelta.trust, 0, 100)
  if (interactionDelta.familiarity) next.familiarity = CLAMP(next.familiarity + interactionDelta.familiarity, 0, 100)

  // 反馈影响
  if (feedbackType === 'positive') {
    next.intimacy = CLAMP(next.intimacy + 1, 0, 100)
    next.trust = CLAMP(next.trust + 0.5, 0, 100)
  } else if (feedbackType === 'negative') {
    next.intimacy = CLAMP(next.intimacy - 2, 0, 100)
  }

  return next
}

// --- RelationshipEngine 主类 ---
export class RelationshipEngine {
  private repository: AppRepository

  constructor(repository: AppRepository) {
    this.repository = repository
  }

  /**
   * 计算主动消息的综合评分
   * 整合了原 scoring.ts 的 calculateProactiveScore
   */
  calculateProactiveScore(context: ProactiveContext): ScoreResult {
    const breakdown: ScoreBreakdown[] = []
    const now = new Date(context.runtimeState.currentTime ?? new Date().toISOString())
    const nowMs = now.getTime()
    const lastProactiveMs = context.runtimeState.lastProactiveAt
      ? new Date(context.runtimeState.lastProactiveAt).getTime()
      : nowMs - 6 * 60 * 60 * 1000
    const minutesSinceLastProactive = Math.max(0, (nowMs - lastProactiveMs) / (60 * 1000))

    breakdown.push({ name: 'time_recovery', value: CLAMP(Math.round((minutesSinceLastProactive / 180) * 30), 0, 30) })

    if (context.runtimeState.userState === 'idle') breakdown.push({ name: 'idle_bonus', value: 15 })
    if (context.runtimeState.userState === 'returned') breakdown.push({ name: 'returned_bonus', value: 25 })

    // 情绪映射
    const emotionMap: Record<string, number> = {
      steady: 0, focused: 5, warm: 6, concerned: -4, drained: -8
    }
    const emotionValue = emotionMap[context.lifecycle.emotion] ?? 0
    if (emotionValue !== 0) breakdown.push({ name: 'emotion_signal', value: emotionValue })

    // 安静时段
    if (context.lifecycle.isQuietHour) breakdown.push({ name: 'quiet_hours_penalty', value: -18 })

    // 时段加成
    if (context.lifecycle.dayPart === 'morning') breakdown.push({ name: 'morning_freshness_bonus', value: 4 })
    else if (context.lifecycle.dayPart === 'evening') breakdown.push({ name: 'evening_reflection_bonus', value: 3 })
    else if (context.lifecycle.dayPart === 'late_night') breakdown.push({ name: 'late_night_penalty', value: -10 })

    // 项目记忆加成
    const projectBonus = getWeightedTypeBonus(context)
    if (projectBonus > 0) breakdown.push({ name: 'project_memory_bonus', value: projectBonus })

    // 最近对话主题匹配
    const recentText = context.recentMessages
      .map((m) => (m.metadata as any)?.content ?? String(m))
      .join(' ')
    if (isCasualTopic(recentText) && !isProjectLike(recentText)) {
      breakdown.push({ name: 'topic_mismatch_penalty', value: -28 })
    }

    // 任务截止加成
    const tasks = context.memories.filter((m) => m.type === 'task')
    const taskScore = getSoonTaskScore(tasks as any, now)
    if (taskScore > 0) breakdown.push({ name: 'task_deadline_bonus', value: taskScore })

    // 用户活跃度加成
    const lastUserMessage = [...context.recentMessages].reverse().find((m) => m.type === 'recent_summary')
    if (lastUserMessage) {
      const minutesSinceLastUserMessage = (nowMs - new Date(lastUserMessage.updatedAt).getTime()) / (60 * 1000)
      if (minutesSinceLastUserMessage <= 180) breakdown.push({ name: 'recent_user_reply_bonus', value: 10 })
      if (minutesSinceLastUserMessage <= 10) breakdown.push({ name: 'recent_conversation_penalty', value: -8 })
    }

    // 活跃时段加成
    const activeHourRatio = getHourScore(context.relationship.preferredHours, now.getHours())
    if (activeHourRatio >= 0.75) breakdown.push({ name: 'activity_hour_bonus', value: 10 })
    else if (activeHourRatio >= 0.45) breakdown.push({ name: 'activity_hour_bonus', value: 5 })

    // 随机抖动
    breakdown.push({ name: 'random_jitter', value: Math.floor(Math.random() * 11) - 5 })

    // 今日次数惩罚
    if (context.runtimeState.todayProactiveCount === 1) breakdown.push({ name: 'daily_count_penalty', value: -10 })
    if (context.runtimeState.todayProactiveCount >= 2) breakdown.push({ name: 'daily_count_penalty', value: -25 })

    // 拒绝惩罚
    if (context.runtimeState.recentlyRejected) breakdown.push({ name: 'rejection_penalty', value: -40 })

    const score = CLAMP(breakdown.reduce((sum, item) => sum + item.value, 0), 0, 100)
    return { score, breakdown }
  }

  /**
   * 根据反馈类型更新关系分数
   */
  async applyFeedback(
    sessionId: string,
    messageId: number,
    feedbackType: FeedbackType,
    topicType: TopicType | null,
    context?: { segmentCount?: number; contentLength?: number; sentHour?: number }
  ): Promise<string> {
    // 这里简化了原 feedbackLearner 的逻辑，实际应更新数据库中的关系数据
    const reason =
      feedbackType === 'negative'
        ? '用户选择了"别打扰"，已进入 cooldown，并下调当前话题的主动性。'
        : feedbackType === 'positive'
          ? `用户认为 ${topicType ?? '该消息'} 有用，已轻微提高话题权重。`
          : `用户认为 ${topicType ?? '该消息'} 一般，已保留偏好样本。`

    await this.repository.applyFeedback({ sessionId, messageId, feedbackType, topicType, context: context as any })
    return reason
  }

  /**
   * 获取当前关系状态
   */
  async getRelationshipState(sessionId: string): Promise<RelationshipState> {
    const runtimeState = await this.repository.getRuntimeState(sessionId)
    return {
      score: {
        intimacy: runtimeState.intimacyScore,
        trust: 50, // 暂不追踪 trust，从 intimacy 推断
        familiarity: Math.min(100, runtimeState.interactionCount * 2)
      },
      lastInteractionAt: runtimeState.lastInteractionAt,
      interactionCount: runtimeState.interactionCount,
      positiveFeedbackCount: 0,
      negativeFeedbackCount: 0,
      preferredHours: runtimeState.preferredHourHistogram,
      preferredSegmentCount: runtimeState.preferredSegmentCount,
      preferredContentLength: runtimeState.preferredContentLength
    }
  }

  /**
   * 更新关系状态
   */
  async updateRelationship(sessionId: string, delta: Partial<RelationshipScore>): Promise<void> {
    if (delta.intimacy) {
      const current = await this.repository.getRuntimeState(sessionId)
      const nextIntimacy = CLAMP(current.intimacyScore + delta.intimacy, 0, 100)
      await this.repository.updateRuntimeSetting(sessionId, 'intimacyScore', String(nextIntimacy))
    }
  }

  /**
   * 解析硬规则阻塞原因
   */
  evaluateHardRules(
    context: ProactiveContext,
    cooldownUntil: string | null
  ): string | null {
    const now = Date.now()
    const userState = context.runtimeState.userState
    const settings = {} as any // 从 context 获取

    if (userState === 'cooldown') {
      if (cooldownUntil && new Date(cooldownUntil).getTime() <= now) {
        return null // cooldown 已过期
      }
      return '当前处于 cooldown，禁止主动发言。'
    }

    if (userState === 'away') return '用户状态为 away，禁止主动发言。'
    if (context.runtimeState.recentlyRejected) return '用户最近点击了"别打扰"，仍在冷却期。'
    if (context.lifecycle.isQuietHour) return '当前处于安静时段，主动消息继续保持静默。'
    if (context.runtimeState.todayProactiveCount >= 3) return '今日主动次数已达到上限。'

    return null
  }
}

export const createRelationshipEngine = (repository: AppRepository) => new RelationshipEngine(repository)
