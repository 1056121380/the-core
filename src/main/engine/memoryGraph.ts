// ============================================================
// MemoryGraph - 数字人记忆图谱
// 统一管理记忆的存储、查询、维护
// 整合了 memoryStore.ts、memoryMaintainer.ts、memorySelector.ts
// ============================================================

import type { MemoryNode, MemoryQuery } from '@main/types/digitalHuman'
import type { MemoryRecord, MemoryType, MemorySource, MessageRecord } from '@shared/types'
import { MemoryStore } from '@main/repositories/memoryStore'
import { getMemoryLayer } from '@shared/constants'
import { createChatCompletion, shouldUseLiveLlm } from '@main/services/llmClient'
import type { SettingsRecord } from '@shared/types'
import { logger } from '@main/services/logger'

// --- 工具函数 ---
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function clip(text: string, max = 72): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function sanitizeText(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// --- MemoryGraph 主类 ---
export class MemoryGraph {
  private readonly store: MemoryStore

  constructor(baseDir?: string, initialMemories: MemoryRecord[] = []) {
    this.store = new MemoryStore()
    this.store.init(baseDir ?? '', initialMemories)
  }

  // --- 查询接口 ---
  list(options?: MemoryQuery): MemoryNode[] {
    return this.store.list(options as any) as MemoryNode[]
  }

  add(input: Omit<MemoryNode, 'id' | 'createdAt' | 'updatedAt'>): MemoryNode {
    return this.store.add(input as any) as MemoryNode
  }

  update(id: number, input: Partial<Pick<MemoryNode, 'content' | 'weight' | 'isPinned' | 'source' | 'metadata'>>): void {
    this.store.update(id, input as any)
  }

  delete(id: number): void {
    this.store.delete(id)
  }

  deleteMany(ids: number[]): void {
    this.store.deleteMany(ids)
  }

  // --- 特定查询 ---
  findRecentSummary(sessionId: string): MemoryNode | null {
    return this.store.findRecentSummary(sessionId) as MemoryNode | null
  }

  upsertRecentSummary(sessionId: string, content: string, weight: number): MemoryNode {
    return this.store.upsertRecentSummary({ sessionId, content, weight }) as MemoryNode
  }

  // --- 记忆维护（整合了 memoryMaintainer 的核心逻辑） ---
  async maintain(
    repository: { listMessages(sessionId: string, limit: number): Promise<MessageRecord[]>; getSettings(): Promise<SettingsRecord>; listMemories(options: any): Promise<MemoryRecord[]>; addMemory(input: any): Promise<MemoryRecord>; updateMemory(id: number, input: any): Promise<void> },
    sessionId: string
  ): Promise<{ summaryMode: 'none' | 'llm' | 'heuristic'; summaryContent: string | null }> {
    const recentMessages = await repository.listMessages(sessionId, 20)
    const settings = await repository.getSettings()

    // 构建摘要
    const llmSummary = await this.buildLlmSummary(recentMessages, settings)
    const heuristicSummary = llmSummary ? null : this.buildHeuristicSummary(recentMessages)
    const summary = llmSummary ?? heuristicSummary
    const summaryMode: 'none' | 'llm' | 'heuristic' = llmSummary ? 'llm' : heuristicSummary ? 'heuristic' : 'none'

    if (summary) {
      this.upsertRecentSummary(sessionId, summary, recentMessages.length >= 6 ? 0.82 : 0.7)
    }

    // 抽取重要记忆
    await this.extractImportantMemories(repository, sessionId, settings, recentMessages)

    // 去重和衰减
    await this.pruneAndDecay(sessionId)

    return { summaryMode, summaryContent: summary }
  }

  private async buildLlmSummary(messages: MessageRecord[], settings: SettingsRecord): Promise<string | null> {
    if (!shouldUseLiveLlm(settings) || messages.length === 0) return null

    const transcript = messages
      .slice(-10)
      .map((m) => `${m.role}: ${clip(m.segments.join(' ') || m.content, 140)}`)
      .join('\n')

    try {
      const raw = await createChatCompletion(
        {
          systemPrompt: '你是记忆压缩器。请把最近对话压缩成 2 到 4 句中文事实摘要，只保留用户目标、当前问题、已明确决定。不要寒暄，不要编号，不要 markdown。',
          messages: [{ role: 'user', content: `请压缩这段最近对话：\n${transcript}` }],
          temperature: 0.2
        },
        settings
      )
      return sanitizeText(raw) || null
    } catch {
      return null
    }
  }

  private buildHeuristicSummary(messages: MessageRecord[]): string | null {
    const recent = messages.slice(-8)
    const userMessages = recent.filter((m) => m.role === 'user')
    const latestUser = userMessages[userMessages.length - 1]
    const previousUser = userMessages[userMessages.length - 2]

    if (!latestUser) return null
    const lines: string[] = []
    if (previousUser) lines.push(`上一轮用户重点：${clip(previousUser.segments.join(' ') || previousUser.content, 80)}。`)
    if (latestUser) lines.push(`当前用户在问：${clip(latestUser.segments.join(' ') || latestUser.content, 80)}。`)
    return clip(lines.join(' '), 220) || null
  }

  private async extractImportantMemories(
    repository: { listMemories(options: any): Promise<MemoryRecord[]>; addMemory(input: any): Promise<MemoryRecord>; updateMemory(id: number, input: any): Promise<void> },
    sessionId: string,
    _settings: SettingsRecord,
    messages: MessageRecord[]
  ): Promise<void> {
    const candidates = this.heuristicCandidatesFromMessages(messages)
    const globalMemories = await repository.listMemories({ sessionId, includeGlobal: true })

    for (const candidate of candidates) {
      if (!candidate.shouldStore) continue

      const existing = globalMemories.find(
        (m) => m.type === candidate.type && !m.sessionId && this.similarMemoryKey(m) === `${candidate.type}::${candidate.content.slice(0, 80)}`
      )

      if (existing) {
        const nextWeight = Math.max(existing.weight, candidate.weight) + 0.04
        await repository.updateMemory(existing.id, { content: candidate.content, weight: Math.min(1, nextWeight) })
      } else {
        await repository.addMemory({
          type: candidate.type,
          content: candidate.content,
          weight: candidate.weight,
          isPinned: false,
          sessionId: null,
          source: 'maintenance'
        })
      }
    }
  }

  private heuristicCandidatesFromMessages(messages: MessageRecord[]): Array<{ type: MemoryType; content: string; weight: number; shouldStore: boolean }> {
    const candidates: Array<{ type: MemoryType; content: string; weight: number; shouldStore: boolean }> = []
    const userTexts = messages.filter((m) => m.role === 'user').slice(-10).map((m) => sanitizeText(m.segments.join(' ') || m.content))

    for (const text of userTexts) {
      if (text.length < 8) continue

      if (/(不喜欢|别太|不要|希望|最好|倾向|习惯)/.test(text)) {
        candidates.push({ type: 'user_preference', content: text, weight: 0.78, shouldStore: true })
      }
      if (/(项目|MVP|第一版|当前在做|目标|主线)/.test(text)) {
        candidates.push({ type: 'project_fact', content: text, weight: 0.76, shouldStore: true })
      }
      if (/(今天|明天|后天|本周|下周|截止|完成|做完)/.test(text)) {
        candidates.push({ type: 'task', content: text, weight: 0.72, shouldStore: true })
      }
    }
    return candidates
  }

  private similarMemoryKey(memory: Pick<MemoryRecord, 'type' | 'content'>): string {
    const content = normalizeText(memory.content).replace(/[，。！？；：、,.!?;:]/g, '')
    return `${memory.type}::${content.slice(0, 80)}`
  }

  private async pruneAndDecay(sessionId: string): Promise<void> {
    const memories = this.list({ sessionId, includeGlobal: true })

    // 去重
    const groups = new Map<string, MemoryRecord[]>()
    for (const memory of memories) {
      const key = `${memory.sessionId ?? 'global'}::${this.similarMemoryKey(memory)}`
      const bucket = groups.get(key) ?? []
      bucket.push(memory as unknown as MemoryRecord)
      groups.set(key, bucket)
    }

    const deleteIds: number[] = []
    for (const bucket of groups.values()) {
      bucket.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
        if (b.weight !== a.weight) return b.weight - a.weight
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
      for (const duplicate of bucket.slice(1)) {
        deleteIds.push(duplicate.id)
      }
    }
    if (deleteIds.length > 0) this.deleteMany(deleteIds)

    // 衰减
    const now = Date.now()
    for (const memory of this.list({ sessionId, includeGlobal: true })) {
      if (memory.isPinned || memory.source === 'system_seed') continue
      const ageDays = (now - new Date(memory.updatedAt).getTime()) / (60 * 60 * 1000 * 24)
      const decayRate = memory.type === 'task' ? 0.01 : memory.type === 'recent_summary' ? 0.035 : 0.008
      const nextWeight = Math.max(0.12, memory.weight - ageDays * decayRate)
      if (Math.abs(nextWeight - memory.weight) >= 0.01) {
        this.update(memory.id, { weight: Number(nextWeight.toFixed(3)) })
      }
    }

    // 剪枝超龄记忆
    const pruneIds = this.list({ sessionId, includeGlobal: true })
      .filter((m) => m.type === 'recent_summary' && m.weight <= 0.18)
      .map((m) => m.id)
    if (pruneIds.length > 0) this.deleteMany(pruneIds)
  }

  // --- 记忆召回（整合了 memorySelector 的核心逻辑） ---
  select(options: { sessionId: string; recentMessages: MessageRecord[]; query?: string }): {
    all: MemoryNode[]
    byType: Record<MemoryType, MemoryNode[]>
  } {
    const contextText = [
      options.query ?? '',
      ...options.recentMessages.slice(-8).map((m) => (m.segments.length > 0 ? m.segments.join(' ') : m.content))
    ].join('\n')

    const tokens = this.tokenize(contextText)
    const memories = this.list({ sessionId: options.sessionId, includeGlobal: true })

    const TYPE_LIMITS: Record<MemoryType, number> = {
      recent_summary: 2, proactive_summary: 2, project_fact: 3,
      project_goal: 2, user_fact: 2, user_preference: 3,
      style_rule: 3, task: 4
    }

    const ranked = memories
      .map((m) => ({ memory: m, score: this.scoreMemory(m, tokens, options.sessionId) }))
      .sort((a, b) => b.score - a.score || b.memory.weight - a.memory.weight)
      .slice(0, 20)

    const byType: Record<MemoryType, MemoryNode[]> = {} as Record<MemoryType, MemoryNode[]>
    for (const memory of ranked.map((r) => r.memory)) {
      const limit = TYPE_LIMITS[memory.type]
      if (!byType[memory.type]) byType[memory.type] = []
      if (byType[memory.type].length < limit) byType[memory.type].push(memory)
    }

    return { all: ranked.map((r) => r.memory), byType }
  }

  private tokenize(text: string): string[] {
    const asciiTokens = text.toLowerCase().split(/[^a-z0-9_]+/i).filter((t) => t.length >= 2)
    const compact = text.replace(/\s+/g, '')
    const chineseTokens: string[] = []
    for (let size = 2; size <= 6; size++) {
      for (let i = 0; i <= compact.length - size; i++) {
        const token = compact.slice(i, i + size)
        if (/^[\u4e00-\u9fff]+$/.test(token)) chineseTokens.push(token)
      }
    }
    return [...new Set([...asciiTokens, ...chineseTokens])].slice(0, 120)
  }

  private scoreMemory(memory: MemoryNode, tokens: string[], sessionId: string): number {
    const TYPE_BASE_SCORE: Record<MemoryType, number> = {
      recent_summary: 28, project_goal: 22, task: 24, proactive_summary: 21,
      project_fact: 20, user_preference: 18, style_rule: 16, user_fact: 14
    }

    let score = TYPE_BASE_SCORE[memory.type] ?? 10
    score += memory.weight * 35
    score += (memory.metadata?.confidence ?? 0.55) * 6
    score += Math.min(memory.metadata?.hitCount ?? 0, 8) * 1.2

    const layer = getMemoryLayer(memory.type)
    if (layer === 'persona') score += 8
    else if (layer === 'short_term') score += 5
    else score += 2

    if (memory.sessionId === sessionId) score += 12
    else if (!memory.sessionId) score += 6

    const recencyHours = Math.max(0, (Date.now() - new Date(memory.updatedAt).getTime()) / (60 * 60 * 1000))
    score += Math.max(0, 10 - recencyHours / 24)

    const normalizedContent = memory.content.toLowerCase()
    for (const token of tokens) {
      if (token.length >= 2 && normalizedContent.includes(token.toLowerCase())) {
        score += token.length >= 4 ? 6 : 3
      }
    }

    return score + Math.min(score, 26)
  }

  getFilePath(): string {
    return this.store.getFilePath()
  }

  clearSessionChatMemories(sessionId: string): void {
    this.store.clearSessionChatMemories(sessionId)
  }

  clearAllChatMemories(): void {
    this.store.clearAllChatMemories()
  }
}

export const createMemoryGraph = (baseDir?: string, initialMemories?: MemoryRecord[]) => new MemoryGraph(baseDir, initialMemories)
