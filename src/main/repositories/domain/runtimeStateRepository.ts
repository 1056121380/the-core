import type { Database } from 'sql.js'
import { getDayPart } from '@shared/constants'
import type {
  EmotionState,
  FeedbackContext,
  FeedbackRecord,
  FeedbackType,
  MemoryRecord,
  MemoryType,
  RuntimeState,
  TopicType
} from '@shared/types'
import { SettingsRepository } from '@main/repositories/domain/settingsRepository'
import type { FeedbackRepository } from '@main/repositories/domain/feedbackRepository'
import { MessageRepository } from '@main/repositories/domain/messageRepository'
import type { MemoryStore } from '@main/repositories/memoryStore'
import { clamp } from '@shared/utils'

const DEFAULT_TOPIC_WEIGHTS: Record<TopicType, number> = {
  greeting: 1,
  project_reminder: 1,
  task_push: 1,
  simple_review: 1,
  casual_chat: 1
}

function sameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function isQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) {
    return false
  }
  if (start < end) {
    return hour >= start && hour < end
  }
  return hour >= start || hour < end
}

export class RuntimeStateRepository {
  constructor(
    private readonly db: Database,
    private readonly persist: () => Promise<void>,
    private readonly settingsRepo: SettingsRepository,
    private readonly messageRepo: MessageRepository
  ) {}

  private getRuntimeValue(sessionId: string, key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM runtime_state WHERE session_id = ? AND key = ? LIMIT 1')
    stmt.bind([sessionId, key])
    const row = stmt.step() ? (stmt.getAsObject() as { value?: string }) : null
    stmt.free()
    return row?.value ?? null
  }

  async updateRuntimeValue(sessionId: string, key: string, value: string): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO runtime_state (session_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value
    `)
    stmt.run([sessionId, key, value])
    stmt.free()
    await this.persist()
  }

  private parseHistogram(raw: string | null): number[] {
    if (!raw) {
      return Array.from({ length: 24 }, () => 0)
    }
    try {
      const parsed = JSON.parse(raw) as unknown[]
      if (!Array.isArray(parsed)) {
        return Array.from({ length: 24 }, () => 0)
      }
      return Array.from({ length: 24 }, (_, index) => Number(parsed[index] ?? 0))
    } catch {
      return Array.from({ length: 24 }, () => 0)
    }
  }

  private parseNullableNumber(raw: string | null): number | null {
    if (!raw) {
      return null
    }
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  private getLocalHour(now: Date, timezone: string): number {
    try {
      const formatter = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        hour12: false,
        timeZone: timezone
      })
      return Number(formatter.format(now))
    } catch {
      return now.getHours()
    }
  }

  private async countTodayProactiveMessages(sessionId: string, now: Date): Promise<number> {
    const stmt = this.db.prepare(`
      SELECT created_at
      FROM messages
      WHERE session_id = ? AND is_proactive = 1
      ORDER BY id DESC
    `)
    stmt.bind([sessionId])
    let count = 0
    while (stmt.step()) {
      const row = stmt.getAsObject() as { created_at?: string }
      if (row.created_at && sameLocalDay(new Date(row.created_at), now)) {
        count += 1
      }
    }
    stmt.free()
    return count
  }

  private deriveMotivationScore(input: {
    userState: RuntimeState['userState']
    intimacyScore: number
    emotionState: EmotionState
    lastInteractionAt: string | null
    preferredHourHistogram: number[]
    localHour: number
    quietHours: boolean
    recentlyRejected: boolean
  }): number {
    let score = 38

    if (input.userState === 'returned') {
      score += 18
    } else if (input.userState === 'idle') {
      score += 7
    } else if (input.userState === 'away') {
      score -= 20
    }

    score += Math.round((input.intimacyScore - 35) * 0.18)

    if (input.lastInteractionAt) {
      const minutes = (Date.now() - new Date(input.lastInteractionAt).getTime()) / (60 * 1000)
      if (minutes <= 120) {
        score += 8
      } else if (minutes >= 24 * 60) {
        score += 5
      }
    }

    if (input.recentlyRejected) {
      score -= 25
    }

    if (input.quietHours) {
      score -= 18
    }

    if (input.emotionState === 'warm') {
      score += 5
    } else if (input.emotionState === 'focused') {
      score += 4
    } else if (input.emotionState === 'drained') {
      score -= 8
    } else if (input.emotionState === 'concerned') {
      score -= 4
    }

    const peak = Math.max(...input.preferredHourHistogram, 0)
    if (peak > 0) {
      const ratio = input.preferredHourHistogram[input.localHour] / peak
      if (ratio >= 0.6) {
        score += 6
      } else if (ratio <= 0.15) {
        score -= 5
      }
    }

    return clamp(score, 0, 100)
  }

  private computeEstrangement(sessionId: string, lastInteractionAt: string | null): number {
    if (!lastInteractionAt) return 0

    const hoursSince = Math.max(0, (Date.now() - new Date(lastInteractionAt).getTime()) / (60 * 60 * 1000))
    if (hoursSince < 4) return 0

    let base: number
    if (hoursSince <= 24) {
      base = Math.min(30, (hoursSince - 4) * 1.5)
    } else {
      const days = hoursSince / 24
      if (days <= 7) {
        base = Math.min(70, 30 + (days - 1) * 7)
      } else {
        base = Math.min(100, 70 + (days - 7) * 3)
      }
    }

    const warmupCount = Math.max(0, this.parseNullableNumber(this.getRuntimeValue(sessionId, 'session_warmup_count')) ?? 0)
    return clamp(base - warmupCount * 25, 0, 100)
  }

  private async decayEmotion(sessionId: string, lastInteractionAt: string | null): Promise<{ state: EmotionState; intensity: number }> {
    const rawState = (this.getRuntimeValue(sessionId, 'emotion_state') as EmotionState | null) ?? 'steady'
    const rawIntensity = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'emotion_intensity')) ?? 48, 0, 100)

    if (rawState === 'steady') {
      return { state: 'steady', intensity: rawIntensity }
    }

    const emotionChangedAt = this.getRuntimeValue(sessionId, 'emotion_changed_at')
    const referenceTime = emotionChangedAt ?? lastInteractionAt
    if (!referenceTime) {
      return { state: rawState, intensity: rawIntensity }
    }

    const hoursSinceChange = Math.max(0, (Date.now() - new Date(referenceTime).getTime()) / (60 * 60 * 1000))
    if (hoursSinceChange < 2) {
      return { state: rawState, intensity: rawIntensity }
    }

    const decayHours = hoursSinceChange - 2
    const decayAmount = decayHours * 2
    const nextIntensity = clamp(rawIntensity - decayAmount, 48, 100)

    if (nextIntensity <= 48) {
      await this.updateRuntimeValue(sessionId, 'emotion_state', 'steady')
      await this.updateRuntimeValue(sessionId, 'emotion_intensity', '48')
      return { state: 'steady', intensity: 48 }
    }

    if (Math.abs(nextIntensity - rawIntensity) >= 1) {
      await this.updateRuntimeValue(sessionId, 'emotion_intensity', String(Number(nextIntensity.toFixed(1))))
    }
    return { state: rawState, intensity: nextIntensity }
  }

  async getRuntimeState(sessionId: string): Promise<RuntimeState> {
    const settings = await this.settingsRepo.getSettings()
    const now = new Date()
    const localHour = this.getLocalHour(now, settings.assistantTimezone)
    const cooldownUntil = this.getRuntimeValue(sessionId, 'cooldown_until') || null
    const cooldownActive = cooldownUntil ? new Date(cooldownUntil).getTime() > now.getTime() : false
    const storedState = this.getRuntimeValue(sessionId, 'user_state')
    const activeHourHistogram = await this.messageRepo.getUserActivityHistogram(sessionId)
    const preferredHourHistogram = this.parseHistogram(this.getRuntimeValue(sessionId, 'preferred_hours'))
    const preferredSegmentCount = this.parseNullableNumber(this.getRuntimeValue(sessionId, 'preferred_segment_count'))
    const preferredContentLength = this.parseNullableNumber(this.getRuntimeValue(sessionId, 'preferred_content_length'))
    const intimacyScore = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'intimacy_score')) ?? 35, 0, 100)
    const interactionCount = Math.max(0, Math.round(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'interaction_count')) ?? 0))
    const lastInteractionAt = this.getRuntimeValue(sessionId, 'last_interaction_at') || null
    const decayed = await this.decayEmotion(sessionId, lastInteractionAt)
    const emotionState = decayed.state
    const emotionIntensity = decayed.intensity
    const userState = cooldownActive ? 'cooldown' : ((storedState as RuntimeState['userState'] | null) ?? 'active')
    const recentlyRejected = cooldownActive
    const quiet = settings.enableEnvironmentAwareness
      ? isQuietHours(localHour, settings.quietHoursStart, settings.quietHoursEnd)
      : false

    const motivationScore = settings.enableMotivationModel
      ? this.deriveMotivationScore({
          userState,
          intimacyScore,
          emotionState,
          lastInteractionAt,
          preferredHourHistogram,
          localHour,
          quietHours: quiet,
          recentlyRejected
        })
      : 50

    return {
      currentTime: now.toISOString(),
      environment: {
        timezone: settings.assistantTimezone,
        locationLabel: settings.assistantLocation,
        weatherSummary: settings.weatherSummary,
        localHour,
        dayPart: getDayPart(localHour),
        isQuietHours: quiet
      },
      lastInteractionAt,
      lastProactiveAt: this.getRuntimeValue(sessionId, 'last_proactive_at') || null,
      todayProactiveCount: await this.countTodayProactiveMessages(sessionId, now),
      cooldownUntil,
      recentlyRejected,
      userState,
      lastRejectedAt: this.getRuntimeValue(sessionId, 'last_rejected_at') || null,
      lastTopicType: (this.getRuntimeValue(sessionId, 'last_topic_type') as TopicType | null) || null,
      activeHourHistogram,
      preferredHourHistogram,
      preferredSegmentCount,
      preferredContentLength,
      emotionState,
      emotionIntensity,
      motivationScore,
      intimacyScore,
      interactionCount,
      conversationalEnergy: clamp(
        this.parseNullableNumber(this.getRuntimeValue(sessionId, 'conversational_energy')) ?? 72,
        0,
        100
      ),
      topicInterest: clamp(
        this.parseNullableNumber(this.getRuntimeValue(sessionId, 'topic_interest')) ?? 62,
        0,
        100
      ),
      desireToTalk: clamp(
        this.parseNullableNumber(this.getRuntimeValue(sessionId, 'desire_to_talk')) ?? 45,
        0,
        100
      ),
      estrangementLevel: this.computeEstrangement(sessionId, lastInteractionAt)
    }
  }

  async getTopicWeights(sessionId: string): Promise<Record<TopicType, number>> {
    const raw = this.getRuntimeValue(sessionId, 'topic_weights')
    if (!raw) {
      return { ...DEFAULT_TOPIC_WEIGHTS }
    }
    try {
      return { ...DEFAULT_TOPIC_WEIGHTS, ...(JSON.parse(raw) as Partial<Record<TopicType, number>>) }
    } catch {
      return { ...DEFAULT_TOPIC_WEIGHTS }
    }
  }

  async clearSessionRuntimeState(sessionId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM runtime_state WHERE session_id = ?')
    stmt.run([sessionId])
    stmt.free()
    await this.persist()
  }

  async updateTopicWeight(sessionId: string, topicType: TopicType, delta: number): Promise<void> {
    const nextWeights = await this.getTopicWeights(sessionId)
    nextWeights[topicType] = Math.max(0.1, Math.min(3, Number((nextWeights[topicType] + delta).toFixed(2))))
    await this.updateRuntimeValue(sessionId, 'topic_weights', JSON.stringify(nextWeights))
  }

  async setUserState(sessionId: string, userState: RuntimeState['userState']): Promise<RuntimeState> {
    await this.updateRuntimeValue(sessionId, 'user_state', userState)
    if (userState !== 'cooldown') {
      await this.updateRuntimeValue(sessionId, 'cooldown_until', '')
    }
    if (userState === 'returned') {
      await this.updateRuntimeValue(sessionId, 'emotion_state', 'warm')
      await this.updateRuntimeValue(sessionId, 'emotion_intensity', '62')
      await this.updateRuntimeValue(sessionId, 'emotion_changed_at', new Date().toISOString())
    } else if (userState === 'active') {
      await this.updateRuntimeValue(sessionId, 'emotion_state', 'focused')
      await this.updateRuntimeValue(sessionId, 'emotion_intensity', '54')
      await this.updateRuntimeValue(sessionId, 'emotion_changed_at', new Date().toISOString())
    }
    return this.getRuntimeState(sessionId)
  }

  async clearCooldown(sessionId: string): Promise<RuntimeState> {
    await this.updateRuntimeValue(sessionId, 'cooldown_until', '')
    await this.updateRuntimeValue(sessionId, 'user_state', 'active')
    await this.updateRuntimeValue(sessionId, 'emotion_state', 'steady')
    await this.updateRuntimeValue(sessionId, 'emotion_intensity', '48')
    await this.updateRuntimeValue(sessionId, 'emotion_changed_at', new Date().toISOString())
    return this.getRuntimeState(sessionId)
  }

  async markUserInteraction(sessionId: string): Promise<void> {
    const lastInteractionAt = this.getRuntimeValue(sessionId, 'last_interaction_at') || null
    const currentEstrangement = this.computeEstrangement(sessionId, lastInteractionAt)
    if (currentEstrangement > 0) {
      const warmupCount = Math.max(0, this.parseNullableNumber(this.getRuntimeValue(sessionId, 'session_warmup_count')) ?? 0)
      await this.updateRuntimeValue(sessionId, 'session_warmup_count', String(warmupCount + 1))
    } else {
      await this.updateRuntimeValue(sessionId, 'session_warmup_count', '0')
    }

    await this.updateRuntimeValue(sessionId, 'last_interaction_at', new Date().toISOString())
    const currentIntimacy = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'intimacy_score')) ?? 35, 0, 100)
    const currentCount = Math.max(0, Math.round(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'interaction_count')) ?? 0))
    await this.updateRuntimeValue(sessionId, 'intimacy_score', String(Number(clamp(currentIntimacy + 0.6, 0, 100).toFixed(2))))
    await this.updateRuntimeValue(sessionId, 'interaction_count', String(currentCount + 1))
    await this.updateRuntimeValue(sessionId, 'emotion_state', 'focused')
    await this.updateRuntimeValue(sessionId, 'emotion_intensity', '55')
    await this.updateRuntimeValue(sessionId, 'emotion_changed_at', new Date().toISOString())

    // Humanization: conversational energy depletes with each exchange,
    // but briefly recovers if the conversation is interesting.
    // Energy also passively recovers slowly over time (+0.5 per interaction).
    const currentEnergy = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'conversational_energy')) ?? 72, 0, 100)
    const currentTopicInterest = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'topic_interest')) ?? 62, 0, 100)
    const energyCost = currentTopicInterest > 65 ? 2.5 : 5.0
    const energyRecovery = currentTopicInterest > 70 ? 3.0 : 0.5
    const energyPassiveRecovery = 0.5 // slow passive regen to prevent total exhaustion
    const nextEnergy = clamp(currentEnergy - energyCost + energyRecovery + energyPassiveRecovery, 0, 100)
    await this.updateRuntimeValue(sessionId, 'conversational_energy', String(Number(nextEnergy.toFixed(1))))

    // Humanization: topic interest fluctuates naturally; nudges toward neutral each turn.
    // If the conversation has been ongoing, interest slowly drifts back toward a comfortable range.
    // A small passive recovery (+0.3) prevents interest from permanently collapsing in long sessions.
    const interestDecay = currentTopicInterest > 60 ? 2.5 : currentTopicInterest < 40 ? 1.0 : 1.5
    const interestDrift = (Math.random() > 0.5 ? interestDecay : -interestDecay)
    // When energy is high, the AI is more engaged and interest tends to rise toward engagement
    const engagementBoost = currentEnergy > 65 ? 1.0 : 0
    const interestPassiveRecovery = 0.3 // slow upward drift to prevent permanent boredom
    const nextInterest = clamp(currentTopicInterest + interestDrift + engagementBoost + interestPassiveRecovery, 0, 100)
    await this.updateRuntimeValue(sessionId, 'topic_interest', String(Number(nextInterest.toFixed(1))))

    // Humanization: desireToTalk slowly recovers over time between proactive events.
    // Without user interaction desire would stay flat; each interaction gives a tiny nudge upward.
    const currentDesire = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'desire_to_talk')) ?? 45, 0, 100)
    const desireRecovery = 1.5 // desire slowly builds up again after speaking
    const nextDesire = clamp(currentDesire + desireRecovery, 0, 100)
    await this.updateRuntimeValue(sessionId, 'desire_to_talk', String(Number(nextDesire.toFixed(1))))
  }

  /**
   * Humanization: update conversational energy after an assistant reply.
   * Speaking costs energy; finishing a satisfying exchange can give a small boost.
   */
  async updateConversationalEnergy(sessionId: string, delta: number): Promise<void> {
    const current = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'conversational_energy')) ?? 72, 0, 100)
    const next = clamp(current + delta, 0, 100)
    await this.updateRuntimeValue(sessionId, 'conversational_energy', String(Number(next.toFixed(1))))
  }

  /**
   * Humanization: update topic interest based on how engaging the current topic is.
   * Positive delta = more interested; negative = losing interest / bored.
   */
  async updateTopicInterest(sessionId: string, delta: number): Promise<void> {
    const current = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'topic_interest')) ?? 62, 0, 100)
    const next = clamp(current + delta, 0, 100)
    await this.updateRuntimeValue(sessionId, 'topic_interest', String(Number(next.toFixed(1))))
  }

  /**
   * Humanization: update desire to talk — separate from score-based motivation.
   * Desire is emotional/impulsive; it's the "I want to say something" feeling.
   */
  async updateDesireToTalk(sessionId: string, delta: number): Promise<void> {
    const current = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'desire_to_talk')) ?? 45, 0, 100)
    const next = clamp(current + delta, 0, 100)
    await this.updateRuntimeValue(sessionId, 'desire_to_talk', String(Number(next.toFixed(1))))
  }

  async markProactiveMessage(sessionId: string, topicType: TopicType): Promise<void> {
    const now = new Date().toISOString()
    await this.updateRuntimeValue(sessionId, 'last_proactive_at', now)
    await this.updateRuntimeValue(sessionId, 'last_topic_type', topicType)
    const currentState = this.getRuntimeValue(sessionId, 'user_state')
    if (currentState === 'returned') {
      await this.updateRuntimeValue(sessionId, 'user_state', 'active')
    }
    // Humanization: speaking satisfies desire — it drops after a proactive message.
    // Speaking also costs conversational energy (proactive speech is more deliberate).
    const currentDesire = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'desire_to_talk')) ?? 45, 0, 100)
    const currentEnergy = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'conversational_energy')) ?? 72, 0, 100)
    await this.updateRuntimeValue(sessionId, 'desire_to_talk', String(Number(clamp(currentDesire - 15, 0, 100).toFixed(1))))
    await this.updateRuntimeValue(sessionId, 'conversational_energy', String(Number(clamp(currentEnergy - 3.5, 0, 100).toFixed(1))))
  }

  private async updateFeedbackPreferences(
    sessionId: string,
    context: FeedbackContext,
    feedbackType: FeedbackType
  ): Promise<void> {
    const currentHours = this.parseHistogram(this.getRuntimeValue(sessionId, 'preferred_hours'))
    const nextHours = [...currentHours]
    const hourDelta = feedbackType === 'positive' ? 1.2 : feedbackType === 'neutral' ? 0.2 : -0.8
    nextHours[context.sentHour] = Number(Math.max(0, nextHours[context.sentHour] + hourDelta).toFixed(2))
    await this.updateRuntimeValue(sessionId, 'preferred_hours', JSON.stringify(nextHours))

    if (feedbackType === 'negative') {
      return
    }

    const currentSegmentCount = this.parseNullableNumber(this.getRuntimeValue(sessionId, 'preferred_segment_count'))
    const currentContentLength = this.parseNullableNumber(this.getRuntimeValue(sessionId, 'preferred_content_length'))
    const segmentWeight = feedbackType === 'positive' ? 0.35 : 0.15
    const contentWeight = feedbackType === 'positive' ? 0.28 : 0.12
    const nextSegmentCount =
      currentSegmentCount == null
        ? context.segmentCount
        : Number((currentSegmentCount * (1 - segmentWeight) + context.segmentCount * segmentWeight).toFixed(2))
    const nextContentLength =
      currentContentLength == null
        ? context.contentLength
        : Number((currentContentLength * (1 - contentWeight) + context.contentLength * contentWeight).toFixed(2))
    await this.updateRuntimeValue(sessionId, 'preferred_segment_count', String(nextSegmentCount))
    await this.updateRuntimeValue(sessionId, 'preferred_content_length', String(nextContentLength))
  }

  private async updateRelationshipState(sessionId: string, feedbackType: FeedbackType): Promise<void> {
    const currentIntimacy = clamp(this.parseNullableNumber(this.getRuntimeValue(sessionId, 'intimacy_score')) ?? 35, 0, 100)
    const nextIntimacy =
      feedbackType === 'positive'
        ? currentIntimacy + 3.5
        : feedbackType === 'neutral'
          ? currentIntimacy + 0.4
          : currentIntimacy - 6
    await this.updateRuntimeValue(sessionId, 'intimacy_score', String(Number(clamp(nextIntimacy, 0, 100).toFixed(2))))

    const now = new Date().toISOString()
    if (feedbackType === 'positive') {
      await this.updateRuntimeValue(sessionId, 'emotion_state', 'warm')
      await this.updateRuntimeValue(sessionId, 'emotion_intensity', '66')
      await this.updateRuntimeValue(sessionId, 'emotion_changed_at', now)
    } else if (feedbackType === 'neutral') {
      await this.updateRuntimeValue(sessionId, 'emotion_state', 'steady')
      await this.updateRuntimeValue(sessionId, 'emotion_intensity', '48')
      await this.updateRuntimeValue(sessionId, 'emotion_changed_at', now)
    } else {
      await this.updateRuntimeValue(sessionId, 'emotion_state', 'concerned')
      await this.updateRuntimeValue(sessionId, 'emotion_intensity', '72')
      await this.updateRuntimeValue(sessionId, 'emotion_changed_at', now)
    }
  }

  async applyFeedback(
    input: {
      sessionId: string
      messageId: number
      feedbackType: FeedbackType
      topicType: TopicType | null
      context?: FeedbackContext | null
    },
    feedbackRepo: FeedbackRepository,
    memoryStore: MemoryStore
  ): Promise<FeedbackRecord> {
    const feedback = await feedbackRepo.createFeedback({
      messageId: input.messageId,
      feedbackType: input.feedbackType,
      topicType: input.topicType,
      context: input.context ?? null
    })

    if (input.topicType) {
      if (input.feedbackType === 'positive') {
        await this.updateTopicWeight(input.sessionId, input.topicType, 0.12)
      } else if (input.feedbackType === 'neutral') {
        await this.updateTopicWeight(input.sessionId, input.topicType, -0.05)
      } else {
        await this.updateTopicWeight(input.sessionId, input.topicType, -0.18)
      }
    }

    // Humanization: positive feedback on a topic reinforces the related memories.
    // e.g. user liked a "task_push" → increment positiveFeedbackCount on task memories.
    // This makes the AI remember "what the user responds well to" at the memory level.
    if (input.feedbackType === 'positive' && input.topicType) {
      const relatedTypes = this.topicTypeToMemoryTypes(input.topicType)
      if (relatedTypes.length > 0) {
        const relatedMemories = memoryStore.list({ types: relatedTypes })
        for (const memory of relatedMemories) {
          const currentCount = memory.metadata?.positiveFeedbackCount ?? 0
          void memoryStore.update(memory.id, {
            metadata: {
              ...memory.metadata,
              positiveFeedbackCount: currentCount + 1
            }
          })
        }
      }
    }

    if (input.context) {
      await this.updateFeedbackPreferences(input.sessionId, input.context, input.feedbackType)
    }

    await this.updateRelationshipState(input.sessionId, input.feedbackType)

    if (input.feedbackType === 'negative') {
      const settings = await this.settingsRepo.getSettings()
      const now = new Date()
      const cooldownUntil = new Date(now.getTime() + settings.cooldownHoursAfterReject * 60 * 60 * 1000)
      await this.updateRuntimeValue(input.sessionId, 'last_rejected_at', now.toISOString())
      await this.updateRuntimeValue(input.sessionId, 'cooldown_until', cooldownUntil.toISOString())
      await this.updateRuntimeValue(input.sessionId, 'user_state', 'cooldown')
    }

    return feedback
  }

  /** Map a proactive topic type to the related memory types for feedback reinforcement. */
  private topicTypeToMemoryTypes(topicType: TopicType): MemoryType[] {
    switch (topicType) {
      case 'task_push':
        return ['task', 'project_goal']
      case 'project_reminder':
        return ['project_fact', 'project_goal']
      case 'greeting':
      case 'casual_chat':
        return ['user_fact', 'user_preference']
      case 'simple_review':
        return ['recent_summary', 'proactive_summary']
      default:
        return []
    }
  }

}
