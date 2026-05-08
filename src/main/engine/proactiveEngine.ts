// ============================================================
// ProactiveEngine - 数字人主动引擎（精简版）
// 负责主动消息的触发调度
// 其他逻辑委托给 DialogEngine、RelationshipEngine、MemoryGraph
// ============================================================

import type { BrowserWindow } from 'electron'
import type { AppRepository } from '@main/repositories/database'
import type { MemoryNode, ProactiveOutput, RelationshipState } from '@main/types/digitalHuman'
import type { TopicType, RuntimeState, SettingsRecord } from '@shared/types'
import { SegmentedMessageService } from '@main/services/segmentedMessage'
import { normalizeSegmentsFromText } from '@main/services/segmentNormalizer'
import { maintainMemories } from '@main/services/memoryMaintainer'
import { identityEngine } from './identityEngine'
import { dialogEngine } from './dialogEngine'
import { RelationshipEngine, createRelationshipEngine } from './relationshipEngine'
import { logger } from '@main/services/logger'

const EMPTY_MEMORIES: MemoryNode[] = []

export class ProactiveEngine {
  private scheduler: NodeJS.Timeout | null = null
  private readonly segmentedMessageService = new SegmentedMessageService()
  private readonly chatRequestVersion = new Map<string, number>()
  private readonly proactiveChecksInFlight = new Set<string>()
  private readonly relationshipEngine: RelationshipEngine

  constructor(
    private readonly repository: AppRepository,
    private readonly mainWindowProvider: () => BrowserWindow | null
  ) {
    this.relationshipEngine = createRelationshipEngine(repository)
  }

  getDefaultSessionId(): string {
    return this.repository.defaultSessionId
  }

  async startScheduler(): Promise<void> {
    const settings = await this.repository.getSettings()
    if (this.scheduler) clearInterval(this.scheduler)
    this.scheduler = setInterval(() => {
      void this.checkProactive(this.repository.defaultSessionId, 'timer')
    }, Math.max(settings.checkIntervalMinutes, 0.1) * 60 * 1000)
  }

  interruptSegmentedOutput(): void {
    this.segmentedMessageService.interrupt()
  }

  async handleIncomingMessage(
    sessionId: string,
    text: string
  ): Promise<{ userMessage: Awaited<ReturnType<AppRepository['createMessage']>> }> {
    logger.info('chat', 'Incoming user message received.', { sessionId, textLength: text.length })
    this.interruptSegmentedOutput()

    const nextVersion = (this.chatRequestVersion.get(sessionId) ?? 0) + 1
    this.chatRequestVersion.set(sessionId, nextVersion)
    await this.repository.markUserInteraction(sessionId)

    const userMessage = await this.repository.createMessage({
      sessionId,
      role: 'user',
      content: text,
      segments: [text],
      topicType: null,
      isProactive: false
    })

    void this.processAssistantReply(sessionId, text, nextVersion)
    return { userMessage }
  }

  private async processAssistantReply(sessionId: string, text: string, version: number): Promise<void> {
    const [recentMessages, memories, settings] = await Promise.all([
      this.repository.listMessages(sessionId, 20),
      this.repository.listMemories({ sessionId, includeGlobal: true }),
      this.repository.getSettings()
    ])

    try {
      const reply = await dialogEngine.reply({ sessionId, userMessage: text, recentMessages, memories: memories as MemoryNode[], settings })

      if (this.chatRequestVersion.get(sessionId) !== version) {
        logger.warn('chat', 'Discarding stale assistant reply.', { sessionId, version })
        return
      }

      const normalizedAssistantSegments = normalizeSegmentsFromText(reply, settings.maxSegments)
      logger.info('chat', 'Assistant reply generated.', { sessionId, replyLength: reply.length, segmentCount: normalizedAssistantSegments.length })

      await this.sendSegments(sessionId, normalizedAssistantSegments, null, false)
    } catch (error) {
      logger.error('chat', 'Failed to generate assistant reply.', { sessionId, error: String(error) })
      if (this.chatRequestVersion.get(sessionId) !== version) return
      await this.sendSegments(sessionId, ['这条回复刚才生成失败了。你再发一次，或者先看一下模型配置和日志。'], null, false)
    }
  }

  async sendSegments(
    sessionId: string,
    segments: string[],
    topicType: TopicType | null = null,
    isProactive = false
  ): Promise<Awaited<ReturnType<AppRepository['createMessage']>>> {
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
      await this.repository.updateMessageSegments(message.id, segments)
      await maintainMemories({ repository: this.repository, sessionId, settings: await this.repository.getSettings() })
      return { ...message, content: segments.join('\n'), segments }
    }

    await this.segmentedMessageService.output({ mainWindow, repository: this.repository, messageId: message.id, sessionId, topicType, segments })
    await maintainMemories({ repository: this.repository, sessionId, settings: await this.repository.getSettings() })

    return { ...message, content: segments.join('\n'), segments }
  }

  async checkProactive(
    sessionId = this.repository.defaultSessionId,
    trigger: 'manual' | 'timer' = 'manual'
  ): Promise<{ decision: 'blocked' | 'silent' | 'speak'; reason: string }> {
    if (this.proactiveChecksInFlight.has(sessionId)) {
      return { decision: 'silent', reason: '当前已有主动检查在进行中。' }
    }
    this.proactiveChecksInFlight.add(sessionId)

    try {
      const [settings, runtimeState, memories, recentMessages] = await Promise.all([
        this.repository.getSettings(),
        this.repository.getRuntimeState(sessionId),
        this.repository.listMemories({ sessionId, includeGlobal: true }),
        this.repository.listMessages(sessionId, 25)
      ])

      // 硬规则检查
      const hardBlock = this.evaluateHardRules(settings, runtimeState)
      if (hardBlock) {
        await this.repository.createProactiveEvent({ sessionId, eventType: trigger, score: null, breakdown: [], decision: 'blocked', reason: hardBlock })
        return { decision: 'blocked', reason: hardBlock }
      }

      // 计算评分
      const relationshipState = await this.relationshipEngine.getRelationshipState(sessionId)
      const proactiveContext = {
        sessionId,
        memories: memories as unknown as MemoryNode[],
        recentMessages: recentMessages as unknown as MemoryNode[],
        relationship: relationshipState,
        lifecycle: {
          currentHour: runtimeState.environment.localHour,
          dayPart: runtimeState.environment.dayPart,
          emotion: runtimeState.emotionState,
          emotionIntensity: runtimeState.emotionIntensity,
          schedule: { wakeHour: 6, sleepHour: 22, activeHours: [{ start: 9, end: 18 }], quietHours: [{ start: 0, end: 8 }] },
          isActiveHour: true,
          isQuietHour: runtimeState.environment.isQuietHours
        },
        runtimeState: {
          currentTime: runtimeState.currentTime,
          userState: runtimeState.userState,
          todayProactiveCount: runtimeState.todayProactiveCount,
          recentlyRejected: runtimeState.recentlyRejected,
          lastProactiveAt: runtimeState.lastProactiveAt
        },
        topicWeights: await this.repository.getTopicWeights(sessionId)
      }

      const scoreResult = this.relationshipEngine.calculateProactiveScore(proactiveContext as any)

      // 阈值判断
      const threshold = settings.threshold
      const nearWindow = Math.max(2, Math.round(settings.proactiveRandomness * 12))
      const floor = threshold - nearWindow

      let shouldSpeak = false
      let reason = ''

      if (scoreResult.score >= threshold) {
        shouldSpeak = true
        reason = `分数 ${scoreResult.score} 达到阈值 ${threshold}。`
      } else if (scoreResult.score >= floor) {
        const chance = (scoreResult.score - floor) / Math.max(1, threshold - floor)
        shouldSpeak = Math.random() <= chance
        reason = shouldSpeak ? `接近阈值，按随机主动策略放行（概率 ${chance.toFixed(2)}）。` : `接近阈值但本轮随机未触发（概率 ${chance.toFixed(2)}）。`
      } else {
        reason = `分数 ${scoreResult.score} 低于阈值 ${threshold}。`
      }

      if (!shouldSpeak) {
        await this.repository.createProactiveEvent({ sessionId, eventType: trigger, score: scoreResult.score, breakdown: scoreResult.breakdown, decision: 'silent', reason })
        return { decision: 'silent', reason }
      }

      // 生成主动消息
      const topicWeights = await this.repository.getTopicWeights(sessionId)
      const selectedTopic = this.selectTopicType(topicWeights, runtimeState.lastTopicType, recentMessages)
      const candidate = await dialogEngine.generateProactiveMessage({
        topicType: selectedTopic,
        userState: runtimeState.userState,
        emotion: runtimeState.emotionState,
        intimacyScore: runtimeState.intimacyScore,
        recentMessages,
        memories: memories as MemoryNode[],
        settings,
        preferredSegmentCount: runtimeState.preferredSegmentCount
      })

      if (!candidate.shouldSpeak || candidate.segments.length === 0) {
        await this.repository.createProactiveEvent({ sessionId, eventType: trigger, score: scoreResult.score, breakdown: scoreResult.breakdown, decision: 'silent', reason: '生成层认为当前不值得主动发言。' })
        return { decision: 'silent', reason: '生成层认为不值得发言。' }
      }

      await this.repository.createProactiveEvent({ sessionId, eventType: trigger, score: scoreResult.score, breakdown: scoreResult.breakdown, decision: 'speak', reason: `${candidate.reason} 将以 ${candidate.segments.length} 段输出。` })
      await this.sendSegments(sessionId, candidate.segments, candidate.topicType, true)
      await this.repository.markProactiveMessage(sessionId, candidate.topicType)
      return { decision: 'speak', reason: '主动消息已发送。' }
    } finally {
      this.proactiveChecksInFlight.delete(sessionId)
    }
  }

  private evaluateHardRules(settings: SettingsRecord, runtimeState: RuntimeState): string | null {
    const now = Date.now()

    if (runtimeState.userState === 'cooldown') {
      if (runtimeState.cooldownUntil && new Date(runtimeState.cooldownUntil).getTime() <= now) {
        // cooldown 已过期
      } else {
        return '当前处于 cooldown，禁止主动发言。'
      }
    }

    if (runtimeState.lastInteractionAt) {
      const minutesSinceInteraction = (now - new Date(runtimeState.lastInteractionAt).getTime()) / (60 * 1000)
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
      return '用户最近点击了"别打扰"，仍在冷却期。'
    }

    if (settings.enableEnvironmentAwareness && runtimeState.environment.isQuietHours) {
      return '当前处于安静时段，主动消息继续保持静默。'
    }

    return null
  }

  private selectTopicType(topicWeights: Record<TopicType, number>, lastTopic: TopicType | null, recentMessages: any[]): TopicType {
    const TOPIC_ORDER: TopicType[] = ['greeting', 'project_reminder', 'task_push', 'simple_review']

    // 简单策略：基于权重和避免重复
    const candidates = TOPIC_ORDER.filter((t) => t !== lastTopic)
    return candidates.sort((a, b) => topicWeights[b] - topicWeights[a])[0] ?? 'greeting'
  }

  // --- 对外委托方法 ---
  async addMemory(input: { type: MemoryNode['type']; content: string; weight: number; isPinned?: boolean; sessionId?: string | null; source?: MemoryNode['source']; metadata?: MemoryNode['metadata'] }): Promise<MemoryNode> {
    return this.repository.addMemory(input as any) as Promise<MemoryNode>
  }

  async deleteMemory(id: number): Promise<void> {
    return this.repository.deleteMemory(id)
  }

  async setMemoryPinned(id: number, isPinned: boolean): Promise<void> {
    await this.repository.updateMemory(id, { isPinned })
  }

  async clearChatSession(sessionId = this.repository.defaultSessionId): Promise<void> {
    this.interruptSegmentedOutput()
    await this.repository.clearSessionMessages(sessionId)
  }

  async updateSettings(input: Partial<SettingsRecord>): Promise<SettingsRecord> {
    const settings = await this.repository.updateSettings(input)
    logger.setLevel(settings.logLevel)
    await this.startScheduler()
    return settings
  }

  async setUserState(userState: RuntimeState['userState'], sessionId = this.repository.defaultSessionId): Promise<RuntimeState> {
    return this.repository.setUserState(userState, sessionId)
  }

  async clearCooldown(sessionId = this.repository.defaultSessionId): Promise<RuntimeState> {
    return this.repository.clearCooldown(sessionId)
  }

  async submitFeedback(input: { sessionId: string; messageId: number; feedbackType: 'positive' | 'neutral' | 'negative'; topicType: TopicType | null }): Promise<void> {
    await this.relationshipEngine.applyFeedback(input.sessionId, input.messageId, input.feedbackType, input.topicType)
  }

  async getSnapshot(sessionId = this.repository.defaultSessionId) {
    const [messages, memories, feedback, settings, runtimeState, latestEvent] = await Promise.all([
      this.repository.listMessages(sessionId),
      this.repository.listMemories({ sessionId, includeGlobal: true }),
      this.repository.listFeedback(sessionId),
      this.repository.getSettings(),
      this.repository.getRuntimeState(sessionId),
      this.repository.getLatestProactiveEvent(sessionId)
    ])
    return { sessionId, messages, memories, feedback, settings, runtimeState, latestEvent }
  }
}
