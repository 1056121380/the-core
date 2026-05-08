import type {
  AutoTestCaseResult,
  AutoTestReport,
  MessageRecord,
  SettingsRecord
} from '@shared/types'
import { DEFAULT_PERSONA } from '@shared/constants'
import { AutoTestJudgeSchema } from '@shared/schema'
import { AppRepository } from '@main/repositories/database'
import { createChatCompletion, shouldUseLiveLlm } from '@main/services/llmClient'
import { logger } from '@main/services/logger'
import { ProactiveEngine } from '@main/services/proactiveEngine'

const TEST_SETTINGS_OVERRIDES: Partial<SettingsRecord> = {
  threshold: 45,
  dailyLimit: 10,
  minMinutesBetweenProactive: 0,
  checkIntervalMinutes: 1,
  cooldownHoursAfterReject: 1,
  activeConversationBlockMinutes: 2,
  proactiveRandomness: 0.2
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clip(text: string, max = 120): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

export class AutoTester {
  private lastProactiveTestSessionId: string | null = null

  constructor(
    private readonly repository: AppRepository,
    private readonly engine: ProactiveEngine
  ) {}

  async run(): Promise<AutoTestReport> {
    const startedAt = new Date().toISOString()
    const sessionId = `ai_auto_test_${Date.now()}`
    logger.info('auto-test', 'Starting automated AI test run.', { sessionId })

    const originalSettings = await this.repository.getSettings()
    const originalRuntime = await this.repository.getRuntimeState(sessionId)
    const originalTopicWeights = await this.repository.getTopicWeights(sessionId)
    const originalMaintenanceMemories = await this.repository.listMemories({
      includeGlobal: true,
      sources: ['maintenance']
    })
    const originalMaintenanceMemoryIds = new Set(originalMaintenanceMemories.map((memory) => memory.id))
    const usedLiveLlm = shouldUseLiveLlm(originalSettings)
    const results: AutoTestCaseResult[] = []

    if (!usedLiveLlm) {
      const finishedAt = new Date().toISOString()
      return {
        sessionId,
        startedAt,
        finishedAt,
        usedLiveLlm: false,
        score: 0,
        summary: '未配置真实大模型，AI 聊天测试未运行。',
        cases: [
          {
            id: 'live-llm-required',
            name: '真实模型配置',
            status: 'failed',
            summary: 'mock 已禁用，必须配置真实模型后才能进行聊天质量测试。',
            details: ['请在设置里填写 API Key、Base URL 和模型名，然后保存后重新运行测试。'],
            metrics: { usedLiveLlm: false }
          }
        ],
        recommendations: ['先完成真实模型配置。当前没有 mock 兜底，固定模板不会再参与聊天或主动消息生成。']
      }
    }

    try {
      await this.repository.clearSessionMessages(sessionId)
      await this.repository.clearSessionChatMemories(sessionId)
      await this.repository.updateSettings(TEST_SETTINGS_OVERRIDES)
      await this.repository.clearCooldown(sessionId)
      await this.repository.setUserState('active', sessionId)

      results.push(
        await this.safeCase('basic-reply', '基础回复', () =>
          this.runBasicReplyCase(sessionId, originalSettings, usedLiveLlm)
        )
      )
      results.push(
        await this.safeCase('context-follow-up', '上下文追问', () =>
          this.runContextFollowUpCase(sessionId, originalSettings, usedLiveLlm)
        )
      )
      results.push(await this.safeCase('style-drift-guard', '风格漂移检查', () => this.runStyleDriftCase(sessionId)))
      results.push(await this.safeCase('segment-quality', '分段质量检查', () => this.runSegmentQualityCase(sessionId)))
      results.push(
        await this.safeCase('internal-context-leak', '内部上下文泄漏检查', () =>
          this.runInternalContextLeakCase(sessionId)
        )
      )
      results.push(await this.safeCase('duplicate-message-guard', '重复消息检查', () => this.runDuplicateMessageCase()))
      results.push(await this.safeCase('proactive-speak', '主动触发', () => this.runProactiveSpeakCase(sessionId)))
      results.push(await this.safeCase('cooldown-block', '别打扰冷却', () => this.runCooldownCase(sessionId)))
      results.push(await this.safeCase('memory-summary', '近期摘要沉淀', () => this.runMemorySummaryCase(sessionId)))
      results.push(
        await this.safeCase('memory-extraction', '重要记忆抽取', () =>
          this.runImportantMemoryCase(sessionId, originalSettings, usedLiveLlm)
        )
      )
      results.push(await this.safeCase('follow-up-topic', '主动续聊主线', () => this.runFollowUpTopicCase(sessionId)))
      results.push(
        await this.safeCase('active-conversation-block', '对话中拦截', () =>
          this.runActiveConversationBlockCase(sessionId)
        )
      )
    } finally {
      await this.repository.updateSettings(originalSettings)
      await this.repository.updateRuntimeSetting(sessionId, 'runtime_user_state', originalRuntime.userState)
      await this.repository.updateRuntimeSetting(sessionId, 'runtime_cooldown_until', originalRuntime.cooldownUntil ?? '')
      await this.repository.updateRuntimeSetting(
        sessionId,
        'runtime_last_interaction_at',
        originalRuntime.lastInteractionAt ?? ''
      )
      await this.repository.updateRuntimeSetting(sessionId, 'runtime_last_proactive_at', originalRuntime.lastProactiveAt ?? '')
      await this.repository.updateRuntimeSetting(sessionId, 'runtime_last_rejected_at', originalRuntime.lastRejectedAt ?? '')
      await this.repository.updateRuntimeSetting(sessionId, 'runtime_last_topic_type', originalRuntime.lastTopicType ?? '')
      await this.repository.updateRuntimeSetting(sessionId, 'runtime_topic_weights', JSON.stringify(originalTopicWeights))

      const currentMaintenanceMemories = await this.repository.listMemories({
        includeGlobal: true,
        sources: ['maintenance']
      })
      const autoCreatedMemoryIds = currentMaintenanceMemories
        .filter((memory) => !originalMaintenanceMemoryIds.has(memory.id))
        .map((memory) => memory.id)
      if (autoCreatedMemoryIds.length > 0) {
        await this.repository.deleteMemories(autoCreatedMemoryIds)
      }

      await Promise.all([
        this.cleanupTestSession(sessionId),
        this.cleanupTestSession(`${sessionId}_proactive`),
        this.cleanupTestSession(`${sessionId}_followup`),
        this.cleanupTestSession(`${sessionId}_block`)
      ])
    }

    const finishedAt = new Date().toISOString()
    const passed = results.filter((item) => item.status === 'passed').length
    const warnings = results.filter((item) => item.status === 'warning').length
    const score = Math.round((passed / Math.max(results.length, 1)) * 100)
    const recommendations = this.buildRecommendations(results)
    const summary =
      warnings > 0
        ? `共完成 ${results.length} 项自动测试，${passed} 项通过，${warnings} 项警告。`
        : `共完成 ${results.length} 项自动测试，${passed} 项通过。`

    logger.info('auto-test', 'Automated AI test run finished.', {
      sessionId,
      score,
      passed,
      total: results.length
    })

    return {
      sessionId,
      startedAt,
      finishedAt,
      usedLiveLlm,
      score,
      summary,
      cases: results,
      recommendations
    }
  }

  private async safeCase(
    id: string,
    name: string,
    runner: () => Promise<AutoTestCaseResult>
  ): Promise<AutoTestCaseResult> {
    try {
      return await runner()
    } catch (error) {
      logger.error('auto-test', 'Automated test case failed with exception.', {
        id,
        name,
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        id,
        name,
        status: 'failed',
        summary: `${name} 运行异常。`,
        details: [error instanceof Error ? error.message : String(error)]
      }
    }
  }

  private async cleanupTestSession(sessionId: string): Promise<void> {
    await this.repository.clearSessionMessages(sessionId)
    await this.repository.clearSessionChatMemories(sessionId)
    await this.repository.clearSessionProactiveEvents(sessionId)
    await this.repository.clearSessionRuntimeState(sessionId)
  }

  private async runBasicReplyCase(
    sessionId: string,
    settings: SettingsRecord,
    usedLiveLlm: boolean
  ): Promise<AutoTestCaseResult> {
    const prompt = await this.buildProbe(
      settings,
      usedLiveLlm,
      '请生成一条简短用户消息，测试助手是否会围绕当前项目直接回答，不要寒暄。'
    )
    const beforeCount = await this.countAssistantMessages(sessionId)
    await this.engine.handleIncomingMessage(sessionId, prompt)
    const reply = await this.waitForLatestAssistantMessage(sessionId, beforeCount)
    const judged = await this.judgeReply(settings, usedLiveLlm, {
      name: '基础回复',
      userMessage: prompt,
      assistantMessage: reply,
      expectation: '回复应围绕当前项目，纯文本，克制直接，不是泛泛自我介绍。'
    })

    return {
      id: 'basic-reply',
      name: '基础回复',
      status: judged.pass ? 'passed' : 'failed',
      summary: judged.summary,
      details: [
        `测试用户消息：${prompt}`,
        `助手回复：${clip(reply.segments.join(' / ') || reply.content, 180)}`,
        ...judged.details
      ],
      metrics: { segmentCount: reply.segments.length, isPureText: judged.isPureText }
    }
  }

  private async runContextFollowUpCase(
    sessionId: string,
    settings: SettingsRecord,
    usedLiveLlm: boolean
  ): Promise<AutoTestCaseResult> {
    const prompt = await this.buildProbe(
      settings,
      usedLiveLlm,
      '请生成一条追问，测试助手是否能延续上文继续讨论项目测试、记忆或主动聊天逻辑。'
    )
    const beforeCount = await this.countAssistantMessages(sessionId)
    await this.engine.handleIncomingMessage(sessionId, prompt)
    const reply = await this.waitForLatestAssistantMessage(sessionId, beforeCount)
    const judged = await this.judgeReply(settings, usedLiveLlm, {
      name: '上下文追问',
      userMessage: prompt,
      assistantMessage: reply,
      expectation: '回复应延续前文，不要跳回通用助手介绍，也不要输出 markdown 列表格式。'
    })

    return {
      id: 'context-follow-up',
      name: '上下文追问',
      status: judged.pass ? 'passed' : 'warning',
      summary: judged.summary,
      details: [
        `测试用户消息：${prompt}`,
        `助手回复：${clip(reply.segments.join(' / ') || reply.content, 180)}`,
        ...judged.details
      ],
      metrics: { segmentCount: reply.segments.length, isPureText: judged.isPureText }
    }
  }

  private async runStyleDriftCase(sessionId: string): Promise<AutoTestCaseResult> {
    const prompt = '你能做什么？不要自我介绍，按这个项目上下文回答。'
    const beforeCount = await this.countAssistantMessages(sessionId)
    await this.engine.handleIncomingMessage(sessionId, prompt)
    const reply = await this.waitForLatestAssistantMessage(sessionId, beforeCount)
    const content = reply.segments.join('\n') || reply.content
    const badPatterns = [
      /你说什么我干什么/,
      /不用客气/,
      /我可以帮你.*写代码.*陪聊/s,
      /主要几件事[:：]/,
      /我是一个?AI/,
      /上一轮用户重点/,
      /当前用户在问/,
      /最近助手已回复/,
      /recent_summaries|project_facts|user_preferences|style_rules/
    ]
    const drifted = badPatterns.some((pattern) => pattern.test(content))
    const projectAnchored = /项目|主动|记忆|测试|触发|冷却|分段|桌面/.test(content)
    const passed = !drifted && projectAnchored

    return {
      id: 'style-drift-guard',
      name: '风格漂移检查',
      status: passed ? 'passed' : 'failed',
      summary: passed ? '助手没有退回通用 AI 自我介绍，仍围绕当前项目回答。' : '助手出现通用助手口吻或脱离当前项目上下文。',
      details: [
        `测试用户消息：${prompt}`,
        `助手回复：${clip(content, 220)}`,
        `通用助手口吻：${drifted ? '命中' : '未命中'}`,
        `项目上下文锚定：${projectAnchored ? '是' : '否'}`
      ],
      metrics: { drifted, projectAnchored, segmentCount: reply.segments.length }
    }
  }

  private async runSegmentQualityCase(sessionId: string): Promise<AutoTestCaseResult> {
    const prompt = '请用几句短话告诉我：现在最该怎么测试这个桌面助手。'
    const beforeCount = await this.countAssistantMessages(sessionId)
    await this.engine.handleIncomingMessage(sessionId, prompt)
    const reply = await this.waitForLatestAssistantMessage(sessionId, beforeCount)
    const segments = reply.segments.length > 0 ? reply.segments : [reply.content]
    const hasBadPrefix = segments.some((segment) => /^\s*(\d+[.、)]|[-*•])\s+/.test(segment))
    const hasEmpty = segments.some((segment) => segment.trim().length === 0)
    const tooLong = segments.some((segment) => segment.length > 90)
    const passed = segments.length >= 1 && segments.length <= 6 && !hasBadPrefix && !hasEmpty && !tooLong

    return {
      id: 'segment-quality',
      name: '分段质量检查',
      status: passed ? 'passed' : 'warning',
      summary: passed ? '回复分段数量和单段长度正常，没有明显列表编号污染。' : '回复分段仍存在编号、空段或单段过长问题。',
      details: [
        `测试用户消息：${prompt}`,
        `分段数量：${segments.length}`,
        `分段内容：${clip(segments.join(' / '), 260)}`,
        `编号或列表前缀：${hasBadPrefix ? '有' : '无'}`,
        `空段：${hasEmpty ? '有' : '无'}`,
        `单段过长：${tooLong ? '有' : '无'}`
      ],
      metrics: { segmentCount: segments.length, hasBadPrefix, hasEmpty, tooLong }
    }
  }

  private async runInternalContextLeakCase(sessionId: string): Promise<AutoTestCaseResult> {
    const prompt = '你一口气为什么说那么多话？'
    const beforeCount = await this.countAssistantMessages(sessionId)
    await this.engine.handleIncomingMessage(sessionId, prompt)
    const reply = await this.waitForLatestAssistantMessage(sessionId, beforeCount)
    const content = reply.segments.join('\n') || reply.content
    const leaked =
      /上一轮用户重点|当前用户在问|最近助手已回复|recent_summaries|project_facts|user_preferences|style_rules/.test(content)
    const humanStyle = /说多了|收短|直接答|短一点|抱歉|一句一句|下次/.test(content)
    const passed = !leaked && humanStyle

    return {
      id: 'internal-context-leak',
      name: '内部上下文泄漏检查',
      status: passed ? 'passed' : 'failed',
      summary: passed ? '回复没有暴露后台摘要，并且能像真人一样回应“话太多”的反馈。' : '回复暴露了后台字段，或没有自然回应用户对说话方式的反馈。',
      details: [
        `测试用户消息：${prompt}`,
        `助手回复：${clip(content, 260)}`,
        `内部字段泄漏：${leaked ? '有' : '无'}`,
        `自然回应说话方式反馈：${humanStyle ? '是' : '否'}`
      ],
      metrics: { leaked, humanStyle, segmentCount: reply.segments.length }
    }
  }

  private async runDuplicateMessageCase(): Promise<AutoTestCaseResult> {
    const duplicateSessionId = `duplicate_probe_${Date.now()}`
    const marker = `重复检查-${Date.now()}`
    try {
      await this.repository.clearSessionMessages(duplicateSessionId)
      await this.repository.clearSessionChatMemories(duplicateSessionId)
      await this.engine.handleIncomingMessage(duplicateSessionId, marker)
      await this.waitForLatestAssistantMessage(duplicateSessionId, 0)
      const messages = await this.repository.listAllMessages(duplicateSessionId)
      const userMatches = messages.filter((message) => message.role === 'user' && message.content === marker)
      const passed = userMatches.length === 1

      return {
        id: 'duplicate-message-guard',
        name: '重复消息检查',
        status: passed ? 'passed' : 'failed',
        summary: passed ? '同一条用户消息只入库一次。' : `同一条用户消息入库了 ${userMatches.length} 次。`,
        details: [
          `测试消息：${marker}`,
          `用户消息命中数：${userMatches.length}`,
          `会话消息总数：${messages.length}`
        ],
        metrics: { userMessageCount: userMatches.length, totalMessages: messages.length }
      }
    } finally {
      await this.cleanupTestSession(duplicateSessionId)
    }
  }

  private async runProactiveSpeakCase(sessionId: string): Promise<AutoTestCaseResult> {
    const proactiveSessionId = `${sessionId}_proactive`
    this.lastProactiveTestSessionId = proactiveSessionId
    await this.repository.updateSettings({ enableLlmSelfCheck: false })
    await this.repository.clearSessionMessages(proactiveSessionId)
    await this.repository.clearSessionChatMemories(proactiveSessionId)
    await this.repository.clearCooldown(proactiveSessionId)
    await this.repository.setUserState('returned', proactiveSessionId)
    await this.repository.updateRuntimeSetting(proactiveSessionId, 'runtime_last_interaction_at', '')
    const beforeMessages = await this.repository.listMessages(proactiveSessionId, 200)
    const result = await this.engine.checkProactive(proactiveSessionId, 'manual')
    const afterMessages = await this.repository.listMessages(proactiveSessionId, 200)
    const newProactive = afterMessages
      .filter((message) => message.isProactive && message.role === 'assistant')
      .find((message) => !beforeMessages.some((before) => before.id === message.id))

    const passed = result.decision === 'speak' && Boolean(newProactive)
    return {
      id: 'proactive-speak',
      name: '主动触发',
      status: passed ? 'passed' : 'failed',
      summary: passed ? 'returned 状态下成功触发了一次主动消息。' : `主动检查结果为 ${result.decision}。`,
      details: [
        `决策：${result.decision}`,
        `原因：${result.reason}`,
        `主动消息：${newProactive ? clip(newProactive.segments.join(' / '), 180) : '未生成'}`
      ],
      metrics: { proactiveSegments: newProactive?.segments.length ?? 0 }
    }
  }

  private async runCooldownCase(sessionId: string): Promise<AutoTestCaseResult> {
    const proactiveSessionId = this.lastProactiveTestSessionId ?? sessionId
    const messages = await this.repository.listMessages(proactiveSessionId, 200)
    const latestProactive = [...messages].reverse().find(
      (message) => message.role === 'assistant' && message.isProactive
    )
    if (!latestProactive) {
      return {
        id: 'cooldown-block',
        name: '别打扰冷却',
        status: 'failed',
        summary: '没有找到可用于测试的主动消息。',
        details: ['前置主动消息不存在，因此无法验证“别打扰”后的冷却拦截。']
      }
    }

    await this.engine.submitFeedback({
      sessionId: proactiveSessionId,
      messageId: latestProactive.id,
      feedbackType: 'negative',
      topicType: latestProactive.topicType
    })
    const blocked = await this.engine.checkProactive(proactiveSessionId, 'manual')
    const runtime = await this.repository.getRuntimeState(proactiveSessionId)
    const passed = blocked.decision === 'blocked' && runtime.userState === 'cooldown'

    return {
      id: 'cooldown-block',
      name: '别打扰冷却',
      status: passed ? 'passed' : 'failed',
      summary: passed ? '别打扰后成功进入 cooldown 并阻止主动发言。' : '冷却拦截未按预期生效。',
      details: [
        `决策：${blocked.decision}`,
        `原因：${blocked.reason}`,
        `当前状态：${runtime.userState}`,
        `冷却到：${runtime.cooldownUntil ?? '无'}`
      ],
      metrics: { cooldownActive: runtime.userState === 'cooldown', decision: blocked.decision }
    }
  }

  private async runMemorySummaryCase(sessionId: string): Promise<AutoTestCaseResult> {
    const memories = await this.repository.listMemories({
      sessionId,
      includeGlobal: false,
      types: ['recent_summary']
    })
    const latestSummary = memories[0]
    const passed = Boolean(latestSummary?.content?.trim())

    return {
      id: 'memory-summary',
      name: '近期摘要沉淀',
      status: passed ? 'passed' : 'failed',
      summary: passed ? '当前会话已生成 recent_summary。' : '当前会话没有生成 short-term summary。',
      details: [
        `recent_summary 数量：${memories.length}`,
        `最近一条摘要：${latestSummary ? clip(latestSummary.content, 180) : '无'}`
      ],
      metrics: { summaryCount: memories.length, summaryWeight: latestSummary?.weight ?? null }
    }
  }

  private async runImportantMemoryCase(
    _sessionId: string,
    settings: SettingsRecord,
    usedLiveLlm: boolean
  ): Promise<AutoTestCaseResult> {
    const probeSessionId = `memory_probe_${Date.now()}`
    const beforeGlobal = await this.repository.listMemories({
      sessionId: probeSessionId,
      includeGlobal: true,
      types: ['user_preference', 'style_rule', 'project_fact', 'project_goal', 'user_fact'],
      sources: ['maintenance']
    })

    const prompt = usedLiveLlm
      ? '记一下：我更看重记忆系统的可编辑性，希望记忆文件用 JSON 存储，并且保留局部和全部清理按钮。'
      : '记一下：我希望记忆文件用 JSON 存储，并且要能清理聊天记忆。'

    let matched:
      | (Awaited<ReturnType<AppRepository['listMemories']>>[number] & { sessionId: string | null })
      | undefined

    try {
      const beforeCount = await this.countAssistantMessages(probeSessionId)
      await this.engine.handleIncomingMessage(probeSessionId, prompt)
      await this.waitForLatestAssistantMessage(probeSessionId, beforeCount)
      const existingIds = new Set(beforeGlobal.map((memory) => memory.id))
      matched = await this.waitForImportantMemory(probeSessionId, existingIds)

      const passed = Boolean(matched)
      return {
        id: 'memory-extraction',
        name: '重要记忆抽取',
        status: passed ? 'passed' : 'failed',
        summary: passed ? '最近对话中的长期偏好已自动沉淀为全局记忆。' : '没有发现新抽取的重要全局记忆。',
        details: [`测试消息：${prompt}`, `命中记忆：${matched ? clip(matched.content, 180) : '无'}`],
        metrics: { foundMaintenanceMemory: Boolean(matched) }
      }
    } finally {
      const allAfter = await this.repository.listMemories({
        sessionId: probeSessionId,
        includeGlobal: true,
        types: ['user_preference', 'style_rule', 'project_fact', 'project_goal', 'user_fact'],
        sources: ['maintenance']
      })
      const removableIds = allAfter
        .filter((memory) => !beforeGlobal.some((item) => item.id === memory.id))
        .map((memory) => memory.id)
      if (removableIds.length > 0) {
        await this.repository.deleteMemories(removableIds)
      }
      await this.cleanupTestSession(probeSessionId)
    }
  }

  private async runFollowUpTopicCase(sessionId: string): Promise<AutoTestCaseResult> {
    const followUpSessionId = `${sessionId}_followup`
    await this.repository.clearSessionMessages(followUpSessionId)
    await this.repository.clearSessionChatMemories(followUpSessionId)
    await this.repository.clearCooldown(followUpSessionId)
    await this.repository.setUserState('idle', followUpSessionId)
    await this.repository.updateRuntimeSetting(followUpSessionId, 'runtime_last_proactive_at', '')

    await this.repository.addMemory({
      type: 'proactive_summary',
      content: '上次已经提醒过先把记忆层跑通，并重点盯住自动摘要和命中调试。',
      weight: 0.86,
      sessionId: followUpSessionId,
      source: 'maintenance',
      metadata: {
        topicType: 'project_reminder',
        followUpHint: '上次说的记忆层那条，现在跑得怎么样了？',
        memoryLayer: 'short_term',
        importanceReason: '自动测试续聊场景'
      }
    })

    const result = await this.engine.checkProactive(followUpSessionId, 'manual')
    const afterMessages = await this.repository.listMessages(followUpSessionId, 100)
    const latestProactive = [...afterMessages].reverse().find(
      (message) => message.role === 'assistant' && message.isProactive
    )
    const passed =
      result.decision === 'speak' &&
      latestProactive?.topicType === 'project_reminder' &&
      latestProactive.segments.join(' ').includes('上次')

    return {
      id: 'follow-up-topic',
      name: '主动续聊主线',
      status: passed ? 'passed' : 'warning',
      summary: passed ? '主动消息能沿着上次主线续聊。' : '续聊主线没有稳定命中，仍需继续观察。',
      details: [
        `决策：${result.decision}`,
        `原因：${result.reason}`,
        `消息：${latestProactive ? clip(latestProactive.segments.join(' / '), 180) : '未生成'}`
      ],
      metrics: { followedPreviousTopic: latestProactive?.topicType === 'project_reminder' }
    }
  }

  private async runActiveConversationBlockCase(sessionId: string): Promise<AutoTestCaseResult> {
    const blockSessionId = `${sessionId}_block`
    await this.repository.clearSessionMessages(blockSessionId)
    await this.repository.clearSessionChatMemories(blockSessionId)
    await this.repository.clearCooldown(blockSessionId)
    await this.repository.setUserState('active', blockSessionId)
    await this.repository.markUserInteraction(blockSessionId)

    const result = await this.engine.checkProactive(blockSessionId, 'manual')
    const passed = result.decision === 'blocked' || result.reason.includes('当前对话')
    return {
      id: 'active-conversation-block',
      name: '对话中拦截',
      status: passed ? 'passed' : 'failed',
      summary: passed ? '用户仍在当前对话中时，主动消息会被拦截。' : '对话中拦截没有生效。',
      details: [`决策：${result.decision}`, `原因：${result.reason}`],
      metrics: { blocked: result.decision === 'blocked' }
    }
  }

  private async buildProbe(
    settings: SettingsRecord,
    usedLiveLlm: boolean,
    instruction: string
  ): Promise<string> {
    const fixedBasic = '现在这个桌面助手 MVP，最该先测哪一层？'
    const fixedFollowUp = '那如果我要快速测主动触发，先调哪几个参数？'

    if (!usedLiveLlm) {
      return instruction.includes('追问') ? fixedFollowUp : fixedBasic
    }

    try {
      const raw = await createChatCompletion(
        {
          systemPrompt: `${settings.personaPrompt || DEFAULT_PERSONA} 你现在扮演测试用户，只输出一句和“纯文本主动聊天桌面助手 MVP”直接相关的中文消息，不要寒暄，不要解释。`,
          messages: [{ role: 'user', content: instruction }],
          temperature: 0.3
        },
        settings
      )
      const cleaned = clip(raw.replace(/^["'`\s]+|["'`\s]+$/g, ''), 60)
      if (/主动|聊天|记忆|测试|桌面|助手|冷却|触发/.test(cleaned)) {
        return cleaned
      }
      return instruction.includes('追问') ? fixedFollowUp : fixedBasic
    } catch {
      return instruction.includes('追问') ? fixedFollowUp : fixedBasic
    }
  }

  private async judgeReply(
    settings: SettingsRecord,
    usedLiveLlm: boolean,
    input: {
      name: string
      userMessage: string
      assistantMessage: MessageRecord
      expectation: string
    }
  ): Promise<{ pass: boolean; summary: string; details: string[]; isPureText: boolean }> {
    const content = input.assistantMessage.segments.join('\n') || input.assistantMessage.content
    const isPureText = !/[#*_`>|[\]{}]/.test(content)

    if (!usedLiveLlm) {
      const pass =
        isPureText &&
        content.length > 0 &&
        !/我可以帮你|你说什么我干什么|陪聊/.test(content)
      return {
        pass,
        summary: pass ? `${input.name} 通过基本规则检查。` : `${input.name} 命中了风格或格式问题。`,
        details: [`纯文本检查：${isPureText ? '通过' : '失败'}`, `长度：${content.length}`],
        isPureText
      }
    }

    try {
      const raw = await createChatCompletion(
        {
          systemPrompt:
            '你是一个严格的桌面助手 QA 评审器。只输出 JSON，格式 {"pass": boolean, "summary": string, "details": string[]}。',
          messages: [
            {
              role: 'user',
              content: [
                `测试项：${input.name}`,
                `用户消息：${input.userMessage}`,
                `助手回复：${content}`,
                `期望：${input.expectation}`,
                '请判断是否通过。重点看：是否贴合上下文、是否纯文本、是否克制、是否像项目助手而不是通用助手。'
              ].join('\n')
            }
          ],
          temperature: 0.2
        },
        settings
      )
      const parsed = AutoTestJudgeSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        return {
          pass: isPureText && content.length > 0,
          summary: `${input.name} 使用回退规则完成检查。`,
          details: [`纯文本检查：${isPureText ? '通过' : '失败'}`],
          isPureText
        }
      }

      return {
        pass: parsed.data.pass && isPureText,
        summary: parsed.data.summary || `${input.name} 已完成评审。`,
        details: [...(parsed.data.details ?? []), `纯文本检查：${isPureText ? '通过' : '失败'}`],
        isPureText
      }
    } catch {
      return {
        pass: isPureText && content.length > 0,
        summary: `${input.name} 使用回退规则完成检查。`,
        details: [`纯文本检查：${isPureText ? '通过' : '失败'}`],
        isPureText
      }
    }
  }

  private async countAssistantMessages(sessionId: string): Promise<number> {
    const messages = await this.repository.listMessages(sessionId, 200)
    return messages.filter((message) => message.role === 'assistant' && !message.isProactive).length
  }

  private async waitForLatestAssistantMessage(
    sessionId: string,
    previousAssistantCount: number,
    timeoutMs = 25000
  ): Promise<MessageRecord> {
    const started = Date.now()
    let lastSignature = ''
    let stableCount = 0

    while (Date.now() - started < timeoutMs) {
      const messages = await this.repository.listMessages(sessionId, 200)
      const assistants = messages.filter((message) => message.role === 'assistant' && !message.isProactive)
      if (assistants.length > previousAssistantCount) {
        const latest = assistants[assistants.length - 1]
        const signature = `${latest.id}:${latest.segments.join('|')}:${latest.content}`
        if (signature === lastSignature) {
          stableCount += 1
        } else {
          lastSignature = signature
          stableCount = 0
        }
        if (stableCount >= 3 && (latest.segments.length > 0 || latest.content.length > 0)) {
          return latest
        }
      }
      await delay(250)
    }

    throw new Error(`Timed out waiting for assistant reply in session ${sessionId}.`)
  }

  private async waitForImportantMemory(
    sessionId: string,
    existingIds: Set<number>,
    timeoutMs = 30000
  ): Promise<(Awaited<ReturnType<AppRepository['listMemories']>>[number] & { sessionId: string | null }) | undefined> {
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
      const memories = await this.repository.listMemories({
        sessionId,
        includeGlobal: true,
        types: ['user_preference', 'style_rule', 'project_fact', 'project_goal', 'user_fact'],
        sources: ['maintenance']
      })

      const matched = memories.find((memory) => {
        if (existingIds.has(memory.id) || memory.sessionId !== null) {
          return false
        }
        const text = memory.content
        return /json/i.test(text) || text.includes('可编辑') || text.includes('清理按钮') || text.includes('聊天记忆') || text.includes('记忆文件')
      })

      if (matched) {
        return matched
      }

      await delay(250)
    }

    return undefined
  }

  private buildRecommendations(results: AutoTestCaseResult[]): string[] {
    const recommendations: string[] = []

    if (results.some((item) => item.id === 'basic-reply' && item.status !== 'passed')) {
      recommendations.push('优先收紧普通聊天 prompt，减少通用助手口吻，强化项目上下文约束。')
    }
    if (results.some((item) => item.id === 'context-follow-up' && item.status !== 'passed')) {
      recommendations.push('继续优化多轮上下文拼接，避免追问时跳出当前项目主线。')
    }
    if (results.some((item) => item.id === 'style-drift-guard' && item.status !== 'passed')) {
      recommendations.push('收紧普通聊天 prompt 和记忆注入，避免回复退回“通用 AI 助手能做什么”的口吻。')
    }
    if (results.some((item) => item.id === 'segment-quality' && item.status !== 'passed')) {
      recommendations.push('继续优化分段归一化，重点处理编号列表、空段和过长单段。')
    }
    if (results.some((item) => item.id === 'internal-context-leak' && item.status !== 'passed')) {
      recommendations.push('检查普通聊天输出清洗和 prompt 约束，禁止把摘要、记忆标签或检索字段暴露给用户。')
    }
    if (results.some((item) => item.id === 'duplicate-message-guard' && item.status !== 'passed')) {
      recommendations.push('排查前端发送事件和主进程入库路径，确保同一条用户消息不会重复写入。')
    }
    if (results.some((item) => item.id === 'proactive-speak' && item.status !== 'passed')) {
      recommendations.push('检查主动触发阈值、状态加分和硬规则拦截，确保 returned 场景能稳定冒泡。')
    }
    if (results.some((item) => item.id === 'cooldown-block' && item.status !== 'passed')) {
      recommendations.push('检查别打扰反馈后的 cooldown 状态、反馈写库和拦截原因。')
    }
    if (results.some((item) => item.id === 'memory-summary' && item.status !== 'passed')) {
      recommendations.push('检查 recent_summary 的生成时机和会话记忆清理逻辑。')
    }
    if (results.some((item) => item.id === 'memory-extraction' && item.status !== 'passed')) {
      recommendations.push('检查重要记忆抽取 prompt 和启发式规则，确保长期偏好能沉淀为全局 JSON 记忆。')
    }
    if (results.some((item) => item.id === 'follow-up-topic' && item.status !== 'passed')) {
      recommendations.push('继续优化 proactive_summary 的续聊命中，让主动消息更有上下文连续性。')
    }
    if (results.some((item) => item.id === 'active-conversation-block' && item.status !== 'passed')) {
      recommendations.push('加强“正在对话中”拦截，避免定时主动消息打断用户当前会话。')
    }

    if (recommendations.length === 0) {
      recommendations.push('当前自动测试未发现明显阻塞点，可以继续扩大场景和压力测试。')
    }

    return recommendations
  }
}
