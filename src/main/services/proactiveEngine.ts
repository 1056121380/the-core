import type { BrowserWindow } from 'electron'
import { DEFAULT_PERSONA } from '@shared/constants'
import { UserInputSchema } from '@shared/schema'
import type {
  AppSnapshot,
  FeedbackType,
  MemoryDebugState,
  MemoryRecord,
  MemorySource,
  ProactiveDecision,
  RuntimeState,
  SettingsRecord,
  TopicType
} from '@shared/types'
import { AppRepository } from '@main/repositories/database'
import { generateAssistantReply } from '@main/services/chatResponder'
import { applyFeedbackLearning } from '@main/services/feedbackLearner'
import { logger } from '@main/services/logger'
import { maintainMemories, type MemoryMaintenanceResult } from '@main/services/memoryMaintainer'
import { generateMessage } from '@main/services/messageGenerator'
import { selectMemories, type MemorySelectionResult } from '@main/services/memorySelector'
import { injectDigression } from '@main/services/proactiveHelpers'
import { calculateProactiveScore } from '@main/services/scoring'
import { runSelfCheck } from '@main/services/selfChecker'
import { SegmentedMessageService } from '@main/services/segmentedMessage'
import { normalizeSegments, normalizeSegmentsFromText } from '@main/services/segmentNormalizer'
import { selectTopic } from '@main/services/topicSelector'
import { clamp } from '@shared/utils'

type TriggerSource = 'manual' | 'timer'

const EMPTY_MEMORY_DEBUG: MemoryDebugState = {
  latestSelectionStage: null,
  latestSelectionQuery: '',
  latestSelectionAt: null,
  selectedMemories: [],
  latestSummaryMode: 'none',
  latestSummaryContent: null,
  latestSummaryAt: null
}

function sameSegments(left: string[], right: string[]): boolean {
  return left.join('\n').trim() === right.join('\n').trim()
}

export class ProactiveEngine {
  private scheduler: NodeJS.Timeout | null = null
  private readonly segmentedMessageService = new SegmentedMessageService()
  private readonly chatRequestVersion = new Map<string, number>()
  private readonly memoryDebugBySession = new Map<string, MemoryDebugState>()
  private readonly proactiveChecksInFlight = new Set<string>()
  private readonly interruptedThoughts = new Map<string, { topicType: TopicType; segments: string[]; at: string }>()
  private schedulerRestarting = false

  constructor(
    private readonly repository: AppRepository,
    private readonly mainWindowProvider: () => BrowserWindow | null
  ) {}

  getDefaultSessionId(): string {
    return this.repository.defaultSessionId
  }

  async startScheduler(): Promise<void> {
    if (this.schedulerRestarting) {
      return
    }
    this.schedulerRestarting = true
    try {
      const settings = await this.repository.getSettings()
      if (this.scheduler) {
        clearInterval(this.scheduler)
        this.scheduler = null
      }
      this.scheduler = setInterval(() => {
        void this.checkProactive(this.repository.defaultSessionId, 'timer')
      }, Math.max(settings.checkIntervalMinutes, 0.1) * 60 * 1000)
    } finally {
      this.schedulerRestarting = false
    }
  }

  interruptSegmentedOutput(): void {
    logger.info('segments', 'Interrupt requested.')
    this.segmentedMessageService.interrupt()
  }

  async getSnapshot(sessionId = this.repository.defaultSessionId): Promise<AppSnapshot> {
    const [messages, memories, feedback, settings, runtimeState, latestEvent] = await Promise.all([
      this.repository.listMessages(sessionId),
      this.repository.listMemories({ sessionId, includeGlobal: true }),
      this.repository.listFeedback(sessionId),
      this.repository.getSettings(),
      this.repository.getRuntimeState(sessionId),
      this.repository.getLatestProactiveEvent(sessionId)
    ])

    return {
      sessionId,
      messages,
      memories,
      feedback,
      settings,
      runtimeState,
      latestEvent,
      memoryDebug: this.memoryDebugBySession.get(sessionId) ?? EMPTY_MEMORY_DEBUG
    }
  }

  async handleIncomingMessage(
    sessionId: string,
    text: string
  ): Promise<{ userMessage: Awaited<ReturnType<AppRepository['createMessage']>> }> {
    const parsed = UserInputSchema.safeParse({ text })
    if (!parsed.success) {
      const errorMessage = parsed.error.errors[0]?.message ?? '无效输入'
      logger.warn('chat', 'Invalid user input rejected.', { sessionId, error: errorMessage })
      throw new Error(errorMessage)
    }
    const safeText = parsed.data.text

    logger.info('chat', 'Incoming user message received.', {
      sessionId,
      textLength: safeText.length
    })

    this.interruptSegmentedOutput()
    const nextVersion = (this.chatRequestVersion.get(sessionId) ?? 0) + 1
    this.chatRequestVersion.set(sessionId, nextVersion)
    await this.repository.markUserInteraction(sessionId)

    const userMessage = await this.repository.createMessage({
      sessionId,
      role: 'user',
      content: safeText,
      segments: [safeText],
      topicType: null,
      isProactive: false
    })

    const runtimeState = await this.repository.getRuntimeState(sessionId)
    void this.processAssistantReply(sessionId, safeText, nextVersion, runtimeState)
    return { userMessage }
  }

  private mergeMemoryDebug(sessionId: string, patch: Partial<MemoryDebugState>): void {
    const current = this.memoryDebugBySession.get(sessionId) ?? EMPTY_MEMORY_DEBUG
    this.memoryDebugBySession.set(sessionId, { ...current, ...patch })
  }

  private recordMemorySelection(
    sessionId: string,
    stage: 'chat' | 'proactive',
    query: string,
    selection: MemorySelectionResult
  ): void {
    this.mergeMemoryDebug(sessionId, {
      latestSelectionStage: stage,
      latestSelectionQuery: query,
      latestSelectionAt: new Date().toISOString(),
      selectedMemories: selection.debugItems
    })
  }

  private async reinforceSelectedMemories(
    stage: 'chat' | 'proactive',
    selection: MemorySelectionResult
  ): Promise<void> {
    const now = new Date().toISOString()
    await Promise.all(
      selection.all.slice(0, 8).map((memory) =>
        this.repository.updateMemory(memory.id, {
          weight: Number(clamp(memory.weight + 0.01, 0.1, 1).toFixed(3)),
          metadata: {
            ...(memory.metadata ?? {}),
            confidence: Number(clamp((memory.metadata?.confidence ?? 0.55) + 0.015, 0, 1).toFixed(3)),
            hitCount: (memory.metadata?.hitCount ?? 0) + 1,
            lastHitAt: now,
            lastHitStage: stage
          }
        })
      )
    )
  }

  private recordMaintenanceResult(sessionId: string, result: MemoryMaintenanceResult): void {
    this.mergeMemoryDebug(sessionId, {
      latestSummaryMode: result.summaryMode,
      latestSummaryContent: result.summaryContent,
      latestSummaryAt: result.summaryUpdatedAt
    })
  }

  private async upsertLastProactiveSummary(
    sessionId: string,
    topicType: TopicType,
    segments: string[]
  ): Promise<void> {
    const latest = (
      await this.repository.listMemories({
        sessionId,
        includeGlobal: false,
        types: ['proactive_summary'],
        limit: 1
      })
    )[0]
    const content = segments.join(' ')
    const lastLine = segments[segments.length - 1] ?? ''
    const followUpHint =
      /[？?]$/.test(lastLine)
        ? lastLine
        : `上次提到的“${content.replace(/[。！？；?]/g, '').slice(0, 18)}”，现在推进得怎么样了？`
    const metadata = {
      topicType,
      sentAt: new Date().toISOString(),
      followUpHint,
      memoryLayer: 'short_term' as const,
      importanceReason: '主动消息续聊摘要'
    }

    if (latest) {
      await this.repository.updateMemory(latest.id, {
        content,
        weight: 0.8,
        source: 'maintenance',
        metadata
      })
      return
    }

    await this.repository.addMemory({
      type: 'proactive_summary',
      content,
      weight: 0.8,
      isPinned: false,
      sessionId,
      source: 'maintenance',
      metadata
    })
  }

  private async processAssistantReply(
    sessionId: string,
    text: string,
    version: number,
    runtimeState: RuntimeState
  ): Promise<void> {
    const [recentMessages, memories, settings] = await Promise.all([
      this.repository.listMessages(sessionId, 20),
      this.repository.listMemories({ sessionId, includeGlobal: true }),
      this.repository.getSettings()
    ])

    const selection = selectMemories({
      memories,
      recentMessages,
      sessionId,
      query: text
    })
    this.recordMemorySelection(sessionId, 'chat', text, selection)
    await this.reinforceSelectedMemories('chat', selection)

    try {
      const reply = await generateAssistantReply({
        sessionId,
        userMessage: text,
        recentMessages,
        memories,
        settings,
        preSelected: selection,
        humanizationState: {
          conversationalEnergy: runtimeState.conversationalEnergy,
          topicInterest: runtimeState.topicInterest,
          desireToTalk: runtimeState.desireToTalk,
          emotionState: runtimeState.emotionState,
          emotionIntensity: runtimeState.emotionIntensity,
          estrangementLevel: runtimeState.estrangementLevel
        }
      })

      if (this.chatRequestVersion.get(sessionId) !== version) {
        logger.warn('chat', 'Discarding stale assistant reply before emission.', { sessionId, version })
        return
      }

      const normalizedAssistantSegments = normalizeSegmentsFromText(reply, settings.maxSegments, {
        intimacyScore: runtimeState.intimacyScore,
        verbalTics: settings.verbalTics,
        estrangementLevel: runtimeState.estrangementLevel
      })
      const finalSegments = injectDigression(normalizedAssistantSegments, {
        intimacyScore: runtimeState.intimacyScore,
        conversationalEnergy: runtimeState.conversationalEnergy,
        availableMemories: memories,
        usedMemoryIds: selection.all.map((m) => m.id)
      })
      logger.info('chat', 'Assistant reply generated.', {
        sessionId,
        replyLength: reply.length,
        segmentCount: finalSegments.length
      })

      await this.sendSegments(sessionId, finalSegments, null, false)
      await this.repository.updateConversationalEnergy(sessionId, -2.0)
      await this.repository.updateTopicInterest(sessionId, -1.5)
    } catch (error) {
      logger.error('chat', 'Failed to generate assistant reply.', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })

      if (this.chatRequestVersion.get(sessionId) !== version) {
        return
      }

      await this.sendSegments(
        sessionId,
        ['这条回复刚才生成失败了。', '你再发一次，或者先看一下模型配置和日志。'],
        null,
        false
      )
    }
  }

  async sendSegments(
    sessionId: string,
    segments: string[],
    topicType: TopicType | null = null,
    isProactive = false
  ): Promise<Awaited<ReturnType<AppRepository['createMessage']>>> {
    logger.info('chat', 'Preparing segmented message.', {
      sessionId,
      topicType,
      isProactive,
      segmentCount: segments.length
    })

    const mainWindow = this.mainWindowProvider()
    const message = await this.repository.createMessage({
      sessionId,
      role: 'assistant',
      content: '',
      segments: [],
      topicType,
      isProactive
    })

    if (!mainWindow) {
      logger.warn('chat', 'Main window unavailable; storing message without live emission.', {
        sessionId,
        messageId: message.id
      })
      await this.repository.updateMessageSegments(message.id, segments)
      const maintenanceResult = await maintainMemories({
        repository: this.repository,
        sessionId,
        settings: await this.repository.getSettings()
      })
      this.recordMaintenanceResult(sessionId, maintenanceResult)
      return { ...message, content: segments.join('\n'), segments }
    }

    const outputResult = await this.segmentedMessageService.output({
      mainWindow,
      repository: this.repository,
      messageId: message.id,
      sessionId,
      topicType,
      segments
    })

    if (isProactive && topicType && outputResult.interrupted) {
      const remainingSegments = segments.slice(outputResult.emittedCount)
      if (remainingSegments.length > 0) {
        this.interruptedThoughts.set(sessionId, {
          topicType,
          segments: remainingSegments,
          at: new Date().toISOString()
        })
      }
      const sentAt = new Date().toISOString()
      const feedbackReason = await applyFeedbackLearning(this.repository, {
        sessionId,
        messageId: message.id,
        feedbackType: 'neutral',
        topicType,
        context: {
          segmentCount: outputResult.emittedCount,
          contentLength: segments.join(' ').length,
          sentHour: new Date(sentAt).getHours(),
          sentAt,
          minutesSinceLastInteraction: null
        }
      })
      await this.repository.createProactiveEvent({
        sessionId,
        eventType: 'implicit_feedback',
        score: null,
        breakdown: [],
        decision: 'silent',
        reason: `隐式反馈：用户打断了主动消息分段输出。${feedbackReason}`
      })
    }

    const maintenanceResult = await maintainMemories({
      repository: this.repository,
      sessionId,
      settings: await this.repository.getSettings()
    })
    this.recordMaintenanceResult(sessionId, maintenanceResult)

    if (isProactive && topicType) {
      await this.upsertLastProactiveSummary(sessionId, topicType, segments)
    }

    return { ...message, content: segments.join('\n'), segments }
  }

  async addMemory(input: {
    type: MemoryRecord['type']
    content: string
    weight: number
    isPinned?: boolean
    sessionId?: string | null
    source?: MemorySource
    metadata?: MemoryRecord['metadata']
  }): Promise<MemoryRecord> {
    logger.info('memory', 'Adding memory.', {
      type: input.type,
      weight: input.weight,
      sessionId: input.sessionId ?? null,
      contentLength: input.content.length
    })
    return this.repository.addMemory(input)
  }

  async deleteMemory(id: number): Promise<void> {
    logger.info('memory', 'Deleting memory.', { id })
    await this.repository.deleteMemory(id)
  }

  async setMemoryPinned(id: number, isPinned: boolean): Promise<void> {
    logger.info('memory', 'Updating memory pin state.', { id, isPinned })
    await this.repository.updateMemory(id, { isPinned })
  }

  async clearChatSession(sessionId = this.repository.defaultSessionId): Promise<void> {
    logger.info('chat', 'Clearing chat session.', { sessionId })
    this.interruptSegmentedOutput()
    await this.repository.clearSessionMessages(sessionId)
  }

  async clearSessionChatMemories(sessionId = this.repository.defaultSessionId): Promise<void> {
    logger.info('memory', 'Clearing session chat memories.', { sessionId })
    await this.repository.clearSessionChatMemories(sessionId)
    this.mergeMemoryDebug(sessionId, {
      latestSummaryMode: 'none',
      latestSummaryContent: null,
      latestSummaryAt: null
    })
  }

  async clearAllChatMemories(): Promise<void> {
    logger.info('memory', 'Clearing all chat-derived memories.')
    await this.repository.clearAllChatMemories()
    for (const [sessionId] of this.memoryDebugBySession) {
      this.mergeMemoryDebug(sessionId, {
        latestSummaryMode: 'none',
        latestSummaryContent: null,
        latestSummaryAt: null
      })
    }
  }

  async updateSettings(input: Partial<SettingsRecord>): Promise<SettingsRecord> {
    logger.info('settings', 'Updating settings.', { keys: Object.keys(input) })
    const settings = await this.repository.updateSettings(input)
    logger.setLevel(settings.logLevel)
    await this.startScheduler()
    return settings
  }

  async setUserState(userState: RuntimeState['userState'], sessionId = this.repository.defaultSessionId): Promise<RuntimeState> {
    logger.info('state', 'Setting user state.', { userState })
    return this.repository.setUserState(userState, sessionId)
  }

  async clearCooldown(sessionId = this.repository.defaultSessionId): Promise<RuntimeState> {
    logger.info('state', 'Clearing cooldown state.')
    return this.repository.clearCooldown(sessionId)
  }

  async submitFeedback(input: {
    sessionId: string
    messageId: number
    feedbackType: FeedbackType
    topicType: TopicType | null
  }): Promise<void> {
    const message = await this.repository.getMessageById(input.messageId)
    const runtimeState = await this.repository.getRuntimeState(input.sessionId)
    const sentAt = message?.createdAt ?? new Date().toISOString()
    const context = message
      ? {
          segmentCount: message.segments.length > 0 ? message.segments.length : 1,
          contentLength: (message.segments.join(' ') || message.content).length,
          sentHour: new Date(sentAt).getHours(),
          sentAt,
          minutesSinceLastInteraction: runtimeState.lastInteractionAt
            ? Math.max(0, (new Date(sentAt).getTime() - new Date(runtimeState.lastInteractionAt).getTime()) / (60 * 1000))
            : null
        }
      : null
    const feedbackInput = { ...input, context }
    const reason = await applyFeedbackLearning(this.repository, feedbackInput)
    logger.info('feedback', 'Feedback processed.', {
      sessionId: input.sessionId,
      messageId: input.messageId,
      feedbackType: input.feedbackType,
      topicType: input.topicType,
      reason
    })
    await this.repository.createProactiveEvent({
      sessionId: input.sessionId,
      eventType: 'feedback',
      score: null,
      breakdown: [],
      decision: 'silent',
      reason
    })
  }

  private resolveSpeakDecision(
    score: number,
    settings: SettingsRecord,
    runtimeState: RuntimeState
  ): { shouldSpeak: boolean; reason: string } {
    // Humanization: desireToTalk is the "I feel like saying something" impulse.
    // High desire can drive speaking even when score is slightly below threshold.
    // Low desire suppresses speaking even when score is technically sufficient.
    // Depleted conversational energy means the AI is "tired" and less likely to initiate.
    const desireModifier = (runtimeState.desireToTalk - 50) * 0.25
    const energyModifier = runtimeState.conversationalEnergy < 25 ? -12 : runtimeState.conversationalEnergy < 50 ? -5 : 0
    const effectiveScore = score + desireModifier + energyModifier

    if (effectiveScore >= settings.threshold) {
      return {
        shouldSpeak: true,
        reason: `有效分数 ${effectiveScore.toFixed(1)}（原始 ${score} + 欲望修正 ${desireModifier.toFixed(1)} + 精力修正 ${energyModifier}）已达到阈值 ${settings.threshold}。欲望值 ${runtimeState.desireToTalk}，精力值 ${runtimeState.conversationalEnergy}。`
      }
    }

    // Even with a low score, strong desire can occasionally override
    if (runtimeState.desireToTalk >= 78 && runtimeState.conversationalEnergy >= 40) {
      const roll = Math.random()
      if (roll <= 0.25) {
        return {
          shouldSpeak: true,
          reason: `欲望爆发：${runtimeState.desireToTalk} ≥ 78，精力充足，25%概率放行（掷骰 ${roll.toFixed(2)}）。`
        }
      }
    }

    const nearWindow = Math.max(2, Math.round(settings.proactiveRandomness * 12))
    const floor = settings.threshold - nearWindow
    if (effectiveScore < floor) {
      return {
        shouldSpeak: false,
        reason: `有效分数 ${effectiveScore.toFixed(1)} 低于阈值 ${settings.threshold}。欲望值 ${runtimeState.desireToTalk}，精力值 ${runtimeState.conversationalEnergy}。`
      }
    }

    const chance = clamp((effectiveScore - floor) / Math.max(1, settings.threshold - floor), 0.05, 0.95)
    const roll = Math.random()
    if (roll <= chance) {
      return {
        shouldSpeak: true,
        reason: `有效分数 ${effectiveScore.toFixed(1)} 接近阈值，按随机主动策略放行（概率 ${chance.toFixed(2)}）。欲望 ${runtimeState.desireToTalk}，精力 ${runtimeState.conversationalEnergy}。`
      }
    }

    return {
      shouldSpeak: false,
      reason: `有效分数 ${effectiveScore.toFixed(1)} 接近阈值 ${settings.threshold}，但随机主动未触发（概率 ${chance.toFixed(2)}）。`
    }
  }

  async checkProactive(
    sessionId = this.repository.defaultSessionId,
    trigger: TriggerSource = 'manual'
  ): Promise<{ decision: ProactiveDecision; reason: string }> {
    if (this.proactiveChecksInFlight.has(sessionId)) {
      logger.warn('proactive', 'Skipping concurrent proactive check.', { sessionId, trigger })
      return { decision: 'silent', reason: '当前已有主动检查在进行中。' }
    }
    this.proactiveChecksInFlight.add(sessionId)
    logger.info('proactive', 'Starting proactive check.', { sessionId, trigger })

    try {
      const [settings, runtimeState, memories, recentMessages, topicWeights] = await Promise.all([
        this.repository.getSettings(),
        this.repository.getRuntimeState(sessionId),
        this.repository.listMemories({ sessionId, includeGlobal: true }),
        this.repository.listMessages(sessionId, 25),
        this.repository.getTopicWeights(sessionId)
      ])

      const blockedReason = this.evaluateHardRules(sessionId, settings, runtimeState)
      if (blockedReason) {
        logger.info('proactive', 'Proactive check blocked by hard rule.', {
          sessionId,
          trigger,
          reason: blockedReason
        })
        await this.repository.createProactiveEvent({
          sessionId,
          eventType: trigger,
          score: null,
          breakdown: [],
          decision: 'blocked',
          reason: blockedReason
        })
        return { decision: 'blocked', reason: blockedReason }
      }

      const context = { settings, runtimeState, memories, recentMessages }
      const scoreResult = calculateProactiveScore(context)
      const estrangementPenalty = runtimeState.estrangementLevel > 40
        ? 1 - runtimeState.estrangementLevel * 0.0015
        : 1
      const adjustedScore = scoreResult.score * estrangementPenalty
      logger.info('proactive', 'Proactive score calculated.', {
        sessionId,
        trigger,
        score: adjustedScore,
        breakdown: scoreResult.breakdown
      })

      const speakDecision = this.resolveSpeakDecision(adjustedScore, settings, runtimeState)
      if (!speakDecision.shouldSpeak) {
        await this.repository.createProactiveEvent({
          sessionId,
          eventType: trigger,
          score: scoreResult.score,
          breakdown: scoreResult.breakdown,
          decision: 'silent',
          reason: speakDecision.reason
        })
        return { decision: 'silent', reason: speakDecision.reason }
      }

      const interrupted = this.interruptedThoughts.get(sessionId)
      if (interrupted) {
        this.interruptedThoughts.delete(sessionId)
        const ageMinutes = (Date.now() - new Date(interrupted.at).getTime()) / (60 * 1000)
        if (ageMinutes < 30) {
          const resumeSegments = ['刚才没说完——', ...interrupted.segments]
          logger.info('proactive', 'Resuming interrupted thought.', { sessionId, topicType: interrupted.topicType })
          await this.repository.createProactiveEvent({
            sessionId,
            eventType: trigger,
            score: scoreResult.score,
            breakdown: scoreResult.breakdown,
            decision: 'speak',
            reason: '恢复上次被打断的主动消息。'
          })
          const normalizedResume = normalizeSegments(resumeSegments, settings.maxSegments)
          await this.sendSegments(sessionId, normalizedResume, interrupted.topicType, true)
          await this.repository.markProactiveMessage(sessionId, interrupted.topicType)
          return { decision: 'speak', reason: '恢复被打断的主动消息。' }
        }
      }

      const topic = await selectTopic(context, topicWeights)
      logger.info('proactive', 'Proactive topic selected.', {
        sessionId,
        trigger,
        topicType: topic.topicType,
        reason: topic.reason
      })

      const query = recentMessages
        .slice(-6)
        .map((message) => (message.segments.length > 0 ? message.segments.join(' ') : message.content))
        .join('\n')
      const selectedMemories = selectMemories({ memories, recentMessages, sessionId, query })
      this.recordMemorySelection(sessionId, 'proactive', query || topic.reason, selectedMemories)
      await this.reinforceSelectedMemories('proactive', selectedMemories)

      const candidate = await generateMessage({
        topicType: topic.topicType,
        userState: runtimeState.userState,
        environment: runtimeState.environment,
        emotionState: runtimeState.emotionState,
        emotionIntensity: runtimeState.emotionIntensity,
        conversationalEnergy: runtimeState.conversationalEnergy,
        topicInterest: runtimeState.topicInterest,
        desireToTalk: runtimeState.desireToTalk,
        motivationScore: runtimeState.motivationScore,
        intimacyScore: runtimeState.intimacyScore,
        recentMessages: recentMessages.flatMap((message) =>
          message.segments.length > 0 ? message.segments : [message.content]
        ),
        recentSummaries: selectedMemories.recentSummaries,
        projectFacts: selectedMemories.projectFacts,
        projectGoals: selectedMemories.projectGoals,
        userFacts: selectedMemories.userFacts,
        userPreferences: selectedMemories.userPreferences,
        styleRules: selectedMemories.styleRules,
        proactiveSummaries: selectedMemories.proactiveSummaries,
        tasks: selectedMemories.tasks,
        preferredSegmentCount: runtimeState.preferredSegmentCount,
        settings,
        persona: settings.personaPrompt || DEFAULT_PERSONA
      })

      if (!candidate.shouldSpeak || candidate.segments.length === 0) {
        logger.info('proactive', 'Message generator decided to stay silent.', {
          sessionId,
          trigger,
          topicType: candidate.topicType,
          segmentCount: candidate.segments.length
        })
        const reason = '生成层认为当前不值得主动发言。'
        await this.repository.createProactiveEvent({
          sessionId,
          eventType: trigger,
          score: scoreResult.score,
          breakdown: scoreResult.breakdown,
          decision: 'silent',
          reason
        })
        return { decision: 'silent', reason }
      }

      if (settings.enableLlmSelfCheck) {
        const selfCheck = await runSelfCheck({
          candidateSegments: candidate.segments,
          userState: runtimeState.userState,
          environment: runtimeState.environment,
          emotionState: runtimeState.emotionState,
          personaPrompt: settings.personaPrompt,
          recentMessages,
          selectedMemories: selectedMemories.all,
          topicType: candidate.topicType,
          maxSegments: settings.maxSegments,
          mockMode: settings.mockMode,
          settings,
          intimacyScore: runtimeState.intimacyScore
        })

        if (!selfCheck.pass) {
          const rewritten = normalizeSegments(
            selfCheck.rewriteSegments.filter(Boolean).slice(0, settings.maxSegments),
            settings.maxSegments
          )
          if (rewritten.length > 0 && !sameSegments(rewritten, candidate.segments)) {
            const retryCheck = await runSelfCheck({
              candidateSegments: rewritten,
              userState: runtimeState.userState,
              environment: runtimeState.environment,
              emotionState: runtimeState.emotionState,
              personaPrompt: settings.personaPrompt,
              recentMessages,
              selectedMemories: selectedMemories.all,
              topicType: candidate.topicType,
              maxSegments: settings.maxSegments,
              mockMode: settings.mockMode,
              settings,
              intimacyScore: runtimeState.intimacyScore
            })
            if (retryCheck.pass) {
              logger.info('proactive', 'Self-check rewrite accepted proactive candidate.', {
                sessionId,
                trigger,
                topicType: candidate.topicType,
                originalReason: selfCheck.reason,
                rewriteReason: retryCheck.reason
              })
              candidate.segments = retryCheck.rewriteSegments.slice(0, settings.maxSegments)
            } else {
              logger.warn('proactive', 'Self-check rewrite still rejected proactive candidate.', {
                sessionId,
                trigger,
                topicType: candidate.topicType,
                reason: retryCheck.reason,
                risk: retryCheck.risk
              })
              const reason = `自检改写后仍未通过：${retryCheck.reason}`
              await this.repository.createProactiveEvent({
                sessionId,
                eventType: trigger,
                score: scoreResult.score,
                breakdown: scoreResult.breakdown,
                decision: 'silent',
                reason
              })
              return { decision: 'silent', reason }
            }
          } else {
          logger.warn('proactive', 'Self-check rejected proactive candidate.', {
            sessionId,
            trigger,
            topicType: candidate.topicType,
            reason: selfCheck.reason,
            risk: selfCheck.risk
          })
          const reason = `自检未通过：${selfCheck.reason}`
          await this.repository.createProactiveEvent({
            sessionId,
            eventType: trigger,
            score: scoreResult.score,
            breakdown: scoreResult.breakdown,
            decision: 'silent',
            reason
          })
          return { decision: 'silent', reason }
          }
        } else {
          candidate.segments = selfCheck.rewriteSegments.slice(0, settings.maxSegments)
        }
      }

      logger.info('proactive', 'Sending proactive message.', {
        sessionId,
        trigger,
        topicType: candidate.topicType,
        segmentCount: candidate.segments.length
      })

      await this.repository.createProactiveEvent({
        sessionId,
        eventType: trigger,
        score: scoreResult.score,
        breakdown: scoreResult.breakdown,
        decision: 'speak',
        reason: `${topic.reason} 将以 ${candidate.segments.length} 段输出。`
      })

      const normalizedCandidateSegments = normalizeSegments(
        candidate.segments.slice(0, settings.maxSegments),
        settings.maxSegments,
        { intimacyScore: runtimeState.intimacyScore, verbalTics: settings.verbalTics, estrangementLevel: runtimeState.estrangementLevel }
      )
      const finalCandidateSegments = injectDigression(normalizedCandidateSegments, {
        intimacyScore: runtimeState.intimacyScore,
        conversationalEnergy: runtimeState.conversationalEnergy,
        availableMemories: memories,
        usedMemoryIds: selectedMemories.all.map((m) => m.id)
      })

      await this.sendSegments(sessionId, finalCandidateSegments, candidate.topicType, true)
      await this.repository.markProactiveMessage(sessionId, candidate.topicType)
      return { decision: 'speak', reason: '主动消息已发送。' }
    } finally {
      this.proactiveChecksInFlight.delete(sessionId)
    }
  }

  evaluateHardRules(
    sessionId: string,
    settings: SettingsRecord,
    runtimeState: RuntimeState
  ): string | null {
    const now = new Date(runtimeState.currentTime).getTime()

    if (runtimeState.userState === 'cooldown') {
      if (runtimeState.cooldownUntil && new Date(runtimeState.cooldownUntil).getTime() <= now) {
        void this.repository.updateRuntimeSetting(sessionId, 'runtime_user_state', 'active')
        void this.repository.updateRuntimeSetting(sessionId, 'runtime_cooldown_until', '')
      } else {
        return '当前处于 cooldown，禁止主动发言。'
      }
    }

    if (runtimeState.lastInteractionAt && runtimeState.userState !== 'returned') {
      const minutesSinceInteraction =
        (now - new Date(runtimeState.lastInteractionAt).getTime()) / (60 * 1000)
      if (minutesSinceInteraction < settings.activeConversationBlockMinutes) {
        return '用户还在当前对话里，暂不插入新的主动消息。'
      }
    }

    if (runtimeState.todayProactiveCount >= settings.dailyLimit) {
      return '今日主动次数已达到上限。'
    }

    if (runtimeState.userState === 'away') {
      return '用户状态为 away，禁止主动发言。'
    }

    if (runtimeState.recentlyRejected) {
      return '用户最近点击了“别打扰”，仍在冷却期。'
    }

    if (settings.enableEnvironmentAwareness && runtimeState.environment.isQuietHours && runtimeState.userState !== 'returned') {
      return '当前处于安静时段，主动消息继续保持静默。'
    }

    if (runtimeState.lastProactiveAt) {
      const minutesSinceLastProactive =
        (now - new Date(runtimeState.lastProactiveAt).getTime()) / (60 * 1000)
      if (minutesSinceLastProactive < settings.minMinutesBetweenProactive) {
        return `距离上次主动发言不足 ${settings.minMinutesBetweenProactive} 分钟。`
      }
    }

    return null
  }
}
