// ============================================================
// DreamService - 数字人做梦服务
// 每天凌晨整理记忆，决定什么存长期、什么模糊化、什么清除
// 让数字人像人一样有选择性地记住重要的事
// ============================================================

import type { MemoryRecord, MessageRecord, SettingsRecord } from '@shared/types'
import { createChatCompletion, shouldUseLiveLlm } from '@main/services/llmClient'
import { logger } from '@main/services/logger'
import type { AppRepository } from '@main/repositories/database'

export interface DreamConfig {
  enabled: boolean
  runHour: number           // 几点运行，默认 0（午夜）
  lookbackDays: number     // 回顾几天内的记忆，默认 7
  maxLongTermKeep: number  // 最多保留多少条长期记忆
}

export interface DreamResult {
  timestamp: string
  memoriesReviewed: number
  keptAsLongTerm: string[]
  fuzzified: string[]
  deleted: string[]
  summary: string
}

function clip(text: string, max = 80): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

export class DreamService {
  private scheduler: NodeJS.Timeout | null = null

  constructor(
    private readonly repository: AppRepository,
    private readonly runHour = 0,
    private readonly lookbackDays = 7
  ) {}

  /**
   * 启动做梦调度器
   * 检查是否该现在运行，否则设置定时器
   */
  startScheduler(): void {
    this.scheduleNextDream()
    logger.info('dream', 'Dream scheduler started.', { runHour: this.runHour })
  }

  stopScheduler(): void {
    if (this.scheduler) {
      clearTimeout(this.scheduler)
      this.scheduler = null
    }
  }

  private scheduleNextDream(): void {
    const now = new Date()
    const targetHour = this.runHour

    // 计算下一个目标时间
    let nextDream = new Date(now)
    nextDream.setHours(targetHour, 0, 0, 0)

    // 如果今天已经过了目标时间，就等到明天
    if (nextDream.getTime() <= now.getTime()) {
      nextDream.setDate(nextDream.getDate() + 1)
    }

    const msUntilDream = nextDream.getTime() - now.getTime()

    this.scheduler = setTimeout(() => {
      void this.runDream()
      this.scheduleNextDream() // 然后设置每天的定时器
    }, msUntilDream)

    logger.info('dream', `Next dream scheduled.`, {
      targetTime: nextDream.toISOString(),
      msUntil: msUntilDream
    })
  }

  /**
   * 执行做梦逻辑
   */
  async runDream(): Promise<DreamResult> {
    const sessionId = this.repository.defaultSessionId
    const settings = await this.repository.getSettings()
    const timestamp = new Date().toISOString()

    logger.info('dream', 'Dream starting.', { sessionId, timestamp })

    // 获取最近的消息和记忆
    const [recentMessages, memories] = await Promise.all([
      this.repository.listMessages(sessionId, 200),
      this.repository.listMemories({ sessionId, includeGlobal: true })
    ])

    // 过滤最近 lookbackDays 天的内容
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - this.lookbackDays)

    const recentMemories = memories.filter(
      (m) => m.source !== 'system_seed' && new Date(m.updatedAt) >= cutoff
    )
    const recentMsgs = recentMessages.filter(
      (m) => new Date(m.createdAt) >= cutoff
    )

    const result: DreamResult = {
      timestamp,
      memoriesReviewed: recentMemories.length,
      keptAsLongTerm: [],
      fuzzified: [],
      deleted: [],
      summary: ''
    }

    if (recentMemories.length === 0 && recentMsgs.length === 0) {
      result.summary = '最近没有需要整理的记忆。'
      logger.info('dream', 'Dream finished - no memories to process.', { ...result })
      return result
    }

    // 构建待分析的内容
    const memorySummary = recentMemories
      .map((m) => `[${m.type}] ${clip(m.content, 100)} (权重:${m.weight.toFixed(2)})`)
      .join('\n')

    const chatSummary = recentMsgs
      .slice(-50)
      .map((m) => `${m.role}: ${clip(m.content || m.segments.join(' '), 80)}`)
      .join('\n')

    if (!shouldUseLiveLlm(settings)) {
      // 没有 LLM 就用简单规则
      result.deleted = recentMemories
        .filter((m) => m.type === 'recent_summary' || m.type === 'proactive_summary')
        .map((m) => clip(m.content, 50))
      result.summary = '无LLM，仅清理了会话摘要。'
      await this.cleanupMemories(result.deleted.map((_, i) => recentMemories[i].id))
      return result
    }

    // 让 LLM 做判断
    const prompt = [
      '你是记忆整理专家。你正在帮一个数字人做"梦"——决定什么要记住、什么要忘掉。',
      '',
      '判断标准：',
      '1. 重要的事（用户明确的目标、偏好、承诺）→ keep_as_long_term',
      '2. 日常小事、闲聊片段 → fuzzify（模糊化，保留但不突出）',
      '3. 过期的临时信息、会话摘要 → delete',
      '4. 如果记忆太矛盾或无用 → delete',
      '',
      '现有记忆：',
      memorySummary || '(无)',
      '',
      '最近的对话：',
      chatSummary || '(无)',
      '',
      '输出格式（严格JSON数组，不要markdown，不要解释）：',
      '[{"action": "keep_as_long_term|fuzzify|delete", "memory_content": "记忆内容的简要描述(20字内)", "reason": "原因(10字内)"}]',
      '',
      '注意：',
      '- keep_as_long_term 最多选 ' + Math.min(10, recentMemories.length) + ' 条',
      '- 只有真正重要的才选 keep_as_long_term',
      '- delete 优先选 recent_summary、proactive_summary 这类临时记忆',
      '- 结果要实际可行，不要全部 keep 或全部 delete'
    ].join('\n')

    try {
      const raw = await createChatCompletion(
        {
          systemPrompt: '你是记忆整理专家，输出严格JSON数组。',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2
        },
        settings
      )

      const decisions = JSON.parse(raw) as Array<{
        action: string
        memory_content: string
        reason: string
      }>

      // 处理每条决定
      for (const decision of decisions) {
        const content = decision.memory_content

        if (decision.action === 'keep_as_long_term') {
          result.keptAsLongTerm.push(content)
        } else if (decision.action === 'fuzzify') {
          result.fuzzified.push(content)
        } else if (decision.action === 'delete') {
          result.deleted.push(content)
        }
      }

      // 执行实际清理
      await this.executeDreamDecisions(recentMemories, decisions)

      // 生成做梦摘要
      result.summary = `整理了 ${result.memoriesReviewed} 条记忆：${result.keptAsLongTerm.length} 条保留，${result.fuzzified.length} 条模糊化，${result.deleted.length} 条删除`

    } catch (error) {
      logger.error('dream', 'Dream failed.', { error: String(error) })
      result.summary = `做梦失败：${error instanceof Error ? error.message : String(error)}`
    }

    logger.info('dream', 'Dream finished.', { ...result })
    return result
  }

  private async executeDreamDecisions(
    memories: MemoryRecord[],
    decisions: Array<{ action: string; memory_content: string; reason: string }>
  ): Promise<void> {
    const deleteIds: number[] = []
    const fuzzifyIds: number[] = []

    for (const decision of decisions) {
      const content = decision.memory_content

      // 找到对应的记忆
      const matched = memories.find(
        (m) => clip(m.content, 50).includes(content) || content.includes(clip(m.content, 50))
      )

      if (!matched) continue

      if (decision.action === 'delete') {
        deleteIds.push(matched.id)
      } else if (decision.action === 'fuzzify') {
        fuzzifyIds.push(matched.id)
      } else if (decision.action === 'keep_as_long_term') {
        // 提高权重，确认为长期记忆
        if (matched.type === 'recent_summary' || matched.type === 'proactive_summary') {
          // 转成 project_fact 或 user_fact
          await this.repository.updateMemory(matched.id, {
            type: 'user_fact',
            weight: Math.min(0.95, matched.weight + 0.1)
          })
        } else {
          await this.repository.updateMemory(matched.id, {
            weight: Math.min(0.95, matched.weight + 0.05)
          })
        }
      }
    }

    // 执行删除
    if (deleteIds.length > 0) {
      await this.repository.deleteMemories(deleteIds)
    }

    // 执行模糊化（降低权重）
    for (const id of fuzzifyIds) {
      const mem = memories.find((m) => m.id === id)
      if (mem) {
        await this.repository.updateMemory(id, {
          weight: Math.max(0.15, mem.weight * 0.5)
        })
      }
    }

    // 清理旧的会话摘要和主动消息摘要
    const oldSessionMemories = memories.filter(
      (m) =>
        (m.type === 'recent_summary' || m.type === 'proactive_summary') &&
        deleteIds.includes(m.id)
    )
    for (const mem of oldSessionMemories) {
      if (!deleteIds.includes(mem.id)) {
        deleteIds.push(mem.id)
      }
    }
    if (oldSessionMemories.length > 0) {
      await this.repository.deleteMemories([...new Set(deleteIds)])
    }
  }

  private async cleanupMemories(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    await this.repository.deleteMemories(ids)
  }
}

export const createDreamService = (repository: AppRepository, config?: Partial<DreamConfig>): DreamService => {
  return new DreamService(
    repository,
    config?.runHour ?? 0,
    config?.lookbackDays ?? 7
  )
}
