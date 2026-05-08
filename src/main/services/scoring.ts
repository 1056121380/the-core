import type { MemoryRecord, ScoreResult } from '@shared/types'
import { clamp } from '@shared/utils'
import type { ProactiveContext } from '@main/types/runtime'
import { getRecentConversationText, isProjectLike, isCasualTopic } from './proactiveHelpers'

function getWeightedTypeBonus(context: ProactiveContext): number {
  const projectMemories = context.memories.filter(
    (memory) => memory.type === 'project_fact' || memory.type === 'project_goal'
  )
  const total = projectMemories.reduce((sum, memory) => sum + memory.weight, 0)
  return clamp(Math.round(total * 6), 0, 12)
}

function getRecentSummaryBonus(context: ProactiveContext): number {
  const recentSummary = context.memories.find((memory) => memory.type === 'recent_summary')
  if (!recentSummary) return 0

  const ageMinutes = (Date.now() - new Date(recentSummary.updatedAt).getTime()) / (60 * 1000)
  if (ageMinutes <= 60) return 6
  if (ageMinutes <= 240) return 4
  if (ageMinutes <= 720) return 2
  return 0
}

function getHourScore(histogram: number[] | undefined, hour: number): number {
  if (!histogram || histogram.length === 0) return 0
  const peak = Math.max(...histogram, 0)
  if (peak <= 0) return 0
  return histogram[hour] / peak
}

function getSoonTaskScore(tasks: MemoryRecord[], now: Date): number {
  const openTasks = tasks.filter((memory) => (memory.metadata?.taskStatus ?? 'open') === 'open')
  let score = 0
  for (const task of openTasks) {
    const deadline = task.metadata?.deadline
    if (!deadline) continue

    const diffHours = (new Date(deadline).getTime() - now.getTime()) / (60 * 60 * 1000)
    if (diffHours <= 0) {
      score = Math.max(score, 26)
    } else if (diffHours <= 24) {
      score = Math.max(score, 20)
    } else if (diffHours <= 72) {
      score = Math.max(score, 10)
    }
  }
  return score
}

function getWeatherAdjustment(summary: string): number {
  const normalized = summary.toLowerCase()
  if (!normalized || normalized.includes('默认不主动引用天气')) return 0
  if (/(storm|heavy rain|台风|暴雨|雷雨|闷热|酷热|大风)/.test(normalized)) return 5
  if (/(clear|sunny|晴|舒适|凉爽)/.test(normalized)) return 2
  return 0
}

export function calculateProactiveScore(context: ProactiveContext): ScoreResult {
  const breakdown: ScoreResult['breakdown'] = []
  const now = new Date(context.runtimeState.currentTime)
  const nowMs = now.getTime()
  const lastProactiveMs = context.runtimeState.lastProactiveAt
    ? new Date(context.runtimeState.lastProactiveAt).getTime()
    : nowMs - 6 * 60 * 60 * 1000
  const minutesSinceLastProactive = Math.max(0, (nowMs - lastProactiveMs) / (60 * 1000))

  breakdown.push({
    name: 'time_recovery',
    value: clamp(Math.round((minutesSinceLastProactive / 180) * 30), 0, 30)
  })

  if (context.runtimeState.userState === 'idle') {
    breakdown.push({ name: 'idle_bonus', value: 15 })
  }
  if (context.runtimeState.userState === 'returned') {
    breakdown.push({ name: 'returned_bonus', value: 25 })
  }
  if (context.settings.proactiveDesireBias !== 0) {
    breakdown.push({
      name: 'desire_bias',
      value: clamp(Math.round(context.settings.proactiveDesireBias), -30, 30)
    })
  }

  if (context.settings.enableMotivationModel) {
    const motivationBonus = Math.round((context.runtimeState.motivationScore - 50) * 0.28)
    if (motivationBonus !== 0) breakdown.push({ name: 'motivation_signal', value: motivationBonus })
  }

  if (context.settings.enableRelationshipModel) {
    const intimacyBonus = Math.round((context.runtimeState.intimacyScore - 35) * 0.15)
    if (intimacyBonus !== 0) breakdown.push({ name: 'relationship_signal', value: intimacyBonus })
  }

  if (context.settings.enableEmotionModel) {
    const emotionMap = {
      steady: 0,
      focused: 5,
      warm: 6,
      concerned: -4,
      drained: -8
    } as const
    const emotionValue = emotionMap[context.runtimeState.emotionState]
    if (emotionValue !== 0) breakdown.push({ name: 'emotion_signal', value: emotionValue })
  }

  // Humanization: desireToTalk acts as an internal "urge" that nudges the score.
  // Neutral desire (50) gives no bonus; high desire boosts; low desire suppresses.
  const desire = context.runtimeState.desireToTalk
  const desireBonus = Math.round((desire - 50) * 0.2)
  if (desireBonus !== 0) breakdown.push({ name: 'desire_to_talk_signal', value: desireBonus })

  // Humanization: conversationalEnergy acts as a fatigue factor.
  // Very low energy makes the AI less likely to initiate.
  const energy = context.runtimeState.conversationalEnergy
  if (energy < 25) {
    breakdown.push({ name: 'energy_exhaustion_penalty', value: -10 })
  } else if (energy < 45) {
    breakdown.push({ name: 'energy_low_penalty', value: -4 })
  }

  if (context.settings.enableEnvironmentAwareness) {
    if (context.runtimeState.environment.isQuietHours) {
      breakdown.push({ name: 'quiet_hours_penalty', value: -18 })
    }
    if (context.runtimeState.environment.dayPart === 'late_night') {
      breakdown.push({ name: 'late_night_penalty', value: -10 })
    } else if (context.runtimeState.environment.dayPart === 'morning') {
      breakdown.push({ name: 'morning_freshness_bonus', value: 4 })
    } else if (context.runtimeState.environment.dayPart === 'evening') {
      breakdown.push({ name: 'evening_reflection_bonus', value: 3 })
    }
    const weatherAdjustment = getWeatherAdjustment(context.runtimeState.environment.weatherSummary)
    if (weatherAdjustment !== 0) breakdown.push({ name: 'weather_context', value: weatherAdjustment })
  }

  const projectBonus = getWeightedTypeBonus(context)
  if (projectBonus > 0) breakdown.push({ name: 'project_memory_bonus', value: projectBonus })

  const recentConversationText = getRecentConversationText(context.recentMessages)
  if (isCasualTopic(recentConversationText) && !isProjectLike(recentConversationText)) {
    breakdown.push({ name: 'topic_mismatch_penalty', value: -28 })
  }

  const summaryBonus = getRecentSummaryBonus(context)
  if (summaryBonus > 0) breakdown.push({ name: 'recent_summary_bonus', value: summaryBonus })

  const tasks = context.memories.filter((memory) => memory.type === 'task')
  const taskScore = getSoonTaskScore(tasks, now)
  if (taskScore > 0) breakdown.push({ name: 'task_deadline_bonus', value: taskScore })

  const lastUserMessage = [...context.recentMessages].reverse().find((message) => message.role === 'user')
  if (lastUserMessage) {
    const minutesSinceLastUserMessage = (nowMs - new Date(lastUserMessage.createdAt).getTime()) / (60 * 1000)
    if (minutesSinceLastUserMessage <= 180) {
      breakdown.push({ name: 'recent_user_reply_bonus', value: 10 })
    }
    if (minutesSinceLastUserMessage <= context.settings.activeConversationBlockMinutes) {
      breakdown.push({ name: 'active_conversation_penalty', value: -20 })
    } else if (minutesSinceLastUserMessage <= 10) {
      breakdown.push({ name: 'recent_conversation_penalty', value: -8 })
    }
  }

  const activeHourRatio = getHourScore(
    context.runtimeState.activeHourHistogram,
    context.runtimeState.environment.localHour
  )
  if (activeHourRatio >= 0.75) {
    breakdown.push({ name: 'activity_hour_bonus', value: 10 })
  } else if (activeHourRatio >= 0.45) {
    breakdown.push({ name: 'activity_hour_bonus', value: 5 })
  } else if (activeHourRatio > 0 && activeHourRatio <= 0.15) {
    breakdown.push({ name: 'activity_hour_penalty', value: -8 })
  }

  const preferredHourRatio = getHourScore(
    context.runtimeState.preferredHourHistogram,
    context.runtimeState.environment.localHour
  )
  if (preferredHourRatio >= 0.6) {
    breakdown.push({ name: 'preferred_hour_bonus', value: 8 })
  } else if (preferredHourRatio > 0 && preferredHourRatio <= 0.15) {
    breakdown.push({ name: 'preferred_hour_penalty', value: -6 })
  }

  const jitterRange = Math.max(1, Math.round(context.settings.proactiveRandomness * 10))
  breakdown.push({
    name: 'random_jitter',
    value: Math.floor(Math.random() * (jitterRange * 2 + 1)) - jitterRange
  })

  if (context.runtimeState.todayProactiveCount === 1) {
    breakdown.push({ name: 'daily_count_penalty', value: -10 })
  }
  if (context.runtimeState.todayProactiveCount >= 2) {
    breakdown.push({ name: 'daily_count_penalty', value: -25 })
  }
  if (context.runtimeState.recentlyRejected) {
    breakdown.push({ name: 'rejection_penalty', value: -40 })
  }

  const lastTwoTopics = context.recentMessages
    .filter((message) => message.role === 'assistant' && message.isProactive && message.topicType)
    .slice(-2)
    .map((message) => message.topicType)
  if (lastTwoTopics.length >= 2 && lastTwoTopics[0] === lastTwoTopics[1]) {
    breakdown.push({ name: 'repetition_penalty', value: -15 })
  }

  const score = clamp(
    breakdown.reduce((sum, item) => sum + item.value, 0),
    0,
    100
  )
  return { score, breakdown }
}
