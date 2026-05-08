import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { getMemoryLayer } from '@shared/constants'
import type { MemoryMetadata, MemoryRecord, MemorySource, MemoryType } from '@shared/types'

interface MemoryStoreDocument {
  version: number
  updatedAt: string
  memories: MemoryRecord[]
}

interface ListMemoryOptions {
  sessionId?: string | null
  includeGlobal?: boolean
  limit?: number
  types?: MemoryType[]
  sources?: MemorySource[]
  query?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizeMemory(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    content: record.content.trim(),
    weight: Number(record.weight ?? 0.5),
    isPinned: Boolean(record.isPinned),
    sessionId: record.sessionId || null,
    source: record.source ?? 'manual',
    metadata: record.metadata
      ? {
          ...((record.metadata as MemoryMetadata | null | undefined) ?? {}),
          memoryLayer: record.metadata.memoryLayer ?? getMemoryLayer(record.type)
        }
      : { memoryLayer: getMemoryLayer(record.type) },
    createdAt: record.createdAt || nowIso(),
    updatedAt: record.updatedAt || nowIso()
  }
}

export class MemoryStore {
  private filePath!: string
  private backupPath!: string
  private document!: MemoryStoreDocument

  init(baseDir: string, initialMemories: MemoryRecord[]): void {
    this.filePath = path.join(baseDir, 'memories.json')
    this.backupPath = `${this.filePath}.bak`

    if (fs.existsSync(this.filePath)) {
      this.document = this.readDocumentWithRecovery()
      return
    }

    const seededMemories = initialMemories
      .map((memory, index) => ({
        ...normalizeMemory(memory),
        id: memory.id || index + 1
      }))
      .sort((left, right) => left.id - right.id)

    this.document = {
      version: 1,
      updatedAt: nowIso(),
      memories: seededMemories
    }
    // Init is called at startup — sync write is acceptable here
    this.persistSync()
  }

  getFilePath(): string {
    return this.filePath
  }

  private readDocumentWithRecovery(): MemoryStoreDocument {
    try {
      return this.readDocument(this.filePath)
    } catch {
      if (fs.existsSync(this.backupPath)) {
        fs.copyFileSync(this.backupPath, this.filePath)
        return this.readDocument(this.filePath)
      }
      throw new Error('Failed to recover memory store from backup.')
    }
  }

  private readDocument(targetPath: string): MemoryStoreDocument {
    const raw = fs.readFileSync(targetPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<MemoryStoreDocument>
    const memories = Array.isArray(parsed.memories)
      ? parsed.memories
          .map((item, index) =>
            normalizeMemory({
              id: Number(item.id ?? index + 1),
              type: item.type as MemoryType,
              content: String(item.content ?? ''),
              weight: Number(item.weight ?? 0.5),
              isPinned: Boolean(item.isPinned),
              sessionId: (item.sessionId as string | null | undefined) ?? null,
              source: (item.source as MemorySource | undefined) ?? 'manual',
              metadata: (item.metadata as MemoryMetadata | null | undefined) ?? null,
              createdAt: String(item.createdAt ?? nowIso()),
              updatedAt: String(item.updatedAt ?? nowIso())
            })
          )
          .filter((item) => item.content.length > 0)
      : []

    return {
      version: Number(parsed.version ?? 1),
      updatedAt: String(parsed.updatedAt ?? nowIso()),
      memories
    }
  }

  private persistSync(): void {
    this.document.updatedAt = nowIso()
    const serialized = JSON.stringify(this.document, null, 2)
    const tempPath = `${this.filePath}.tmp`
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath)
    }
    fs.writeFileSync(tempPath, serialized, 'utf8')
    fs.renameSync(tempPath, this.filePath)
  }

  private async persist(): Promise<void> {
    this.document.updatedAt = nowIso()
    const serialized = JSON.stringify(this.document, null, 2)
    const tempPath = `${this.filePath}.tmp`
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath)
    }
    await fsPromises.writeFile(tempPath, serialized, 'utf8')
    await fsPromises.rename(tempPath, this.filePath)
  }

  private nextId(): number {
    return this.document.memories.reduce((maxId, item) => Math.max(maxId, item.id), 0) + 1
  }

  list(options?: ListMemoryOptions): MemoryRecord[] {
    const includeGlobal = options?.includeGlobal ?? true

    let memories = [...this.document.memories]

    if (options?.sessionId) {
      memories = memories.filter((memory) =>
        includeGlobal
          ? memory.sessionId === options.sessionId || memory.sessionId === null
          : memory.sessionId === options.sessionId
      )
    } else if (!includeGlobal) {
      memories = memories.filter((memory) => memory.sessionId !== null)
    }

    if (options?.types?.length) {
      memories = memories.filter((memory) => options.types?.includes(memory.type))
    }

    if (options?.sources?.length) {
      memories = memories.filter((memory) => options.sources?.includes(memory.source))
    }

    if (options?.query?.trim()) {
      const query = normalizeText(options.query)
      memories = memories.filter((memory) => normalizeText(memory.content).includes(query))
    }

    memories.sort((left, right) => {
      if (left.isPinned !== right.isPinned) {
        return left.isPinned ? -1 : 1
      }
      if (right.weight !== left.weight) {
        return right.weight - left.weight
      }
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    })

    if (options?.limit) {
      memories = memories.slice(0, options.limit)
    }

    return memories
  }

  async add(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    const createdAt = nowIso()
    const record: MemoryRecord = normalizeMemory({
      id: this.nextId(),
      createdAt,
      updatedAt: createdAt,
      ...input
    })
    this.document.memories.push(record)
    await this.persist()
    return record
  }

  async update(
    id: number,
    input: Partial<
      Pick<MemoryRecord, 'type' | 'content' | 'weight' | 'isPinned' | 'sessionId' | 'source' | 'metadata'>
    >
  ): Promise<void> {
    const index = this.document.memories.findIndex((memory) => memory.id === id)
    if (index < 0) {
      return
    }
    const current = this.document.memories[index]
    this.document.memories[index] = normalizeMemory({
      ...current,
      ...input,
      updatedAt: nowIso()
    })
    await this.persist()
  }

  async delete(id: number): Promise<void> {
    const next = this.document.memories.filter((memory) => memory.id !== id)
    if (next.length === this.document.memories.length) {
      return
    }
    this.document.memories = next
    await this.persist()
  }

  async deleteMany(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return
    }
    const idSet = new Set(ids)
    this.document.memories = this.document.memories.filter((memory) => !idSet.has(memory.id))
    await this.persist()
  }

  findRecentSummary(sessionId: string): MemoryRecord | null {
    return (
      this.list({
        sessionId,
        includeGlobal: false,
        types: ['recent_summary'],
        sources: ['chat_summary'],
        limit: 1
      })[0] ?? null
    )
  }

  async upsertRecentSummary(input: { sessionId: string; content: string; weight: number }): Promise<MemoryRecord> {
    const existing = this.findRecentSummary(input.sessionId)
    if (existing) {
      await this.update(existing.id, {
        content: input.content,
        weight: input.weight,
        source: 'chat_summary',
        isPinned: existing.isPinned
      })
      return this.findRecentSummary(input.sessionId) as MemoryRecord
    }
    return this.add({
      type: 'recent_summary',
      content: input.content,
      weight: input.weight,
      isPinned: false,
      sessionId: input.sessionId,
      source: 'chat_summary'
    })
  }

  async clearSessionChatMemories(sessionId: string): Promise<void> {
    this.document.memories = this.document.memories.filter(
      (memory) =>
        !(
          memory.sessionId === sessionId &&
          (
            memory.source === 'chat_summary' ||
            memory.type === 'recent_summary' ||
            memory.type === 'proactive_summary'
          )
        )
    )
    await this.persist()
  }

  async clearAllChatMemories(): Promise<void> {
    this.document.memories = this.document.memories.filter(
      (memory) =>
        memory.source !== 'chat_summary' &&
        memory.type !== 'recent_summary' &&
        memory.type !== 'proactive_summary'
    )
    await this.persist()
  }
}
