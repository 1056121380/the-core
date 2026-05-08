import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import type { Database, SqlJsStatic } from 'sql.js'
import { DEFAULT_MEMORIES } from '@shared/constants'
import { MemoryStore } from '@main/repositories/memoryStore'
import { SettingsRepository } from '@main/repositories/domain/settingsRepository'
import { MessageRepository } from '@main/repositories/domain/messageRepository'
import { FeedbackRepository } from '@main/repositories/domain/feedbackRepository'
import { ProactiveEventRepository } from '@main/repositories/domain/proactiveEventRepository'
import { RuntimeStateRepository } from '@main/repositories/domain/runtimeStateRepository'
import type {
  FeedbackRecord,
  FeedbackType,
  MemoryMetadata,
  MemoryRecord,
  MemorySource,
  MemoryType,
  MessageRecord,
  ProactiveDecision,
  ProactiveEventRecord,
  RuntimeState,
  SettingsRecord,
  TopicType
} from '@shared/types'

type LegacyMemoryType = 'short_term_memory' | 'project_memory' | 'user_preferences'

const LEGACY_TYPE_MAP: Record<LegacyMemoryType, MemoryType> = {
  short_term_memory: 'recent_summary',
  project_memory: 'project_fact',
  user_preferences: 'user_preference'
}

function normalizeMemoryType(raw: string): MemoryType {
  if (raw in LEGACY_TYPE_MAP) {
    return LEGACY_TYPE_MAP[raw as LegacyMemoryType]
  }
  return raw as MemoryType
}

function validateSqlIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`)
  }
  return name
}

export class AppRepository {
  readonly defaultSessionId = 'desktop_default'
  private readonly targetSchemaVersion = 2
  private sql!: SqlJsStatic
  private db!: Database
  private dbPath!: string
  private readonly memoryStore = new MemoryStore()

  private settingsRepo!: SettingsRepository
  private messageRepo!: MessageRepository
  private feedbackRepo!: FeedbackRepository
  private proactiveEventRepo!: ProactiveEventRepository
  private runtimeStateRepo!: RuntimeStateRepository

  private persistFn = async (): Promise<void> => {
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()))
  }

  async init(): Promise<void> {
    const baseDir = path.join(app.getPath('userData'), 'data')
    fs.mkdirSync(baseDir, { recursive: true })
    this.dbPath = path.join(baseDir, 'assistant.sqlite')
    const sqlJsModule = await import(
      pathToFileURL(path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.js')).href
    )
    const initSqlJs = (sqlJsModule.default ?? sqlJsModule) as (
      config: { locateFile: (file: string) => string }
    ) => Promise<SqlJsStatic>
    this.sql = await initSqlJs({
      locateFile: (file: string) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file)
    })
    const existing = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : undefined
    this.db = existing ? new this.sql.Database(existing) : new this.sql.Database()
    this.db.run(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL DEFAULT 'desktop_default',
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        segments_json TEXT,
        topic_type TEXT,
        is_proactive INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        feedback_type TEXT NOT NULL,
        topic_type TEXT,
        context_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proactive_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL DEFAULT 'desktop_default',
        event_type TEXT NOT NULL,
        score REAL,
        breakdown_json TEXT,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      );
    `)

    this.ensureColumn('messages', 'session_id', "TEXT NOT NULL DEFAULT 'desktop_default'")
    this.ensureColumn('proactive_events', 'session_id', "TEXT NOT NULL DEFAULT 'desktop_default'")
    this.ensureColumn('memories', 'session_id', 'TEXT')
    this.ensureColumn('memories', 'source', "TEXT NOT NULL DEFAULT 'manual'")
    this.ensureColumn('memories', 'is_pinned', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('feedback', 'context_json', 'TEXT')
    await this.runMigrations()

    this.settingsRepo = new SettingsRepository(this.db, this.persistFn)
    this.messageRepo = new MessageRepository(this.db, this.persistFn)
    this.feedbackRepo = new FeedbackRepository(this.db, this.persistFn)
    this.proactiveEventRepo = new ProactiveEventRepository(this.db, this.persistFn)
    this.runtimeStateRepo = new RuntimeStateRepository(
      this.db,
      this.persistFn,
      this.settingsRepo,
      this.messageRepo
    )

    const legacyMemories = this.readLegacyMemoriesForMigration()
    this.memoryStore.init(baseDir, legacyMemories.length > 0 ? legacyMemories : this.buildDefaultMemories())
    await this.settingsRepo.seedDefaults()
    await this.migrateLegacyMemories()
    await this.persistFn()
  }

  private getSchemaVersion(): number {
    const stmt = this.db.prepare('PRAGMA user_version')
    const row = stmt.step() ? (stmt.getAsObject() as { user_version?: number }) : null
    stmt.free()
    return Number(row?.user_version ?? 0)
  }

  private setSchemaVersion(version: number): void {
    const safeVersion = Math.floor(Number(version))
    if (!Number.isFinite(safeVersion) || safeVersion < 0) return
    this.db.run(`PRAGMA user_version = ${safeVersion}`)
  }

  private async runMigrations(): Promise<void> {
    const current = this.getSchemaVersion()
    if (current < 1) {
      this.setSchemaVersion(1)
    }

    if (current < 2) {
      const legacyRuntimeKeys = [
        'runtime_user_state',
        'runtime_cooldown_until',
        'runtime_last_interaction_at',
        'runtime_last_proactive_at',
        'runtime_last_rejected_at',
        'runtime_last_topic_type',
        'runtime_topic_weights',
        'runtime_preferred_hours',
        'runtime_preferred_segment_count',
        'runtime_preferred_content_length'
      ]

      for (const key of legacyRuntimeKeys) {
        const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
        stmt.bind([key])
        const row = stmt.step() ? (stmt.getAsObject() as { value?: string }) : null
        stmt.free()
        if (!row?.value) {
          continue
        }
        const nextKey = key.replace(/^runtime_/, '')
        const insertStmt = this.db.prepare(`
          INSERT INTO runtime_state (session_id, key, value)
          VALUES (?, ?, ?)
          ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value
        `)
        insertStmt.run([this.defaultSessionId, nextKey, row.value])
        insertStmt.free()
      }
      this.setSchemaVersion(this.targetSchemaVersion)
      await this.persistFn()
    }
  }

  getDatabasePath(): string {
    return this.dbPath
  }

  getMemoryFilePath(): string {
    return this.memoryStore.getFilePath()
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const safeTable = validateSqlIdentifier(tableName)
    const safeColumn = validateSqlIdentifier(columnName)
    const stmt = this.db.prepare(`PRAGMA table_info(${safeTable})`)
    const columns: Array<{ name: string }> = []
    while (stmt.step()) {
      columns.push(stmt.getAsObject() as { name: string })
    }
    stmt.free()
    if (!columns.some((column) => column.name === columnName)) {
      this.db.run(`ALTER TABLE ${safeTable} ADD COLUMN ${safeColumn} ${definition}`)
    }
  }

  private buildDefaultMemories(): MemoryRecord[] {
    const now = new Date().toISOString()
    return DEFAULT_MEMORIES.map((memory, index) => ({
      id: index + 1,
      type: memory.type,
      content: memory.content,
      weight: memory.weight,
      isPinned: memory.isPinned,
      sessionId: memory.sessionId,
      source: memory.source,
      createdAt: now,
      updatedAt: now
    }))
  }

  private readLegacyMemoriesForMigration(): MemoryRecord[] {
    const stmt = this.db.prepare('SELECT * FROM memories ORDER BY id ASC')
    const rows: Array<{
      id: number
      type: string
      content: string
      weight: number
      is_pinned: number | null
      session_id: string | null
      source: string | null
      created_at: string | null
      updated_at: string | null
    }> = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as (typeof rows)[0])
    }
    stmt.free()

    return rows
      .map((row) => ({
        id: Number(row.id),
        type: normalizeMemoryType(row.type),
        content: row.content,
        weight: Number(row.weight ?? 0.5),
        isPinned: Boolean(row.is_pinned),
        sessionId: row.session_id || null,
        source: (row.source as MemorySource | null) ?? 'manual',
        createdAt: row.created_at ?? new Date().toISOString(),
        updatedAt: row.updated_at ?? new Date().toISOString()
      }))
      .filter((memory) => memory.content.trim().length > 0)
  }

  private async migrateLegacyMemories(): Promise<void> {
    const stmt = this.db.prepare('SELECT id, type, source, session_id, is_pinned FROM memories')
    const rows: Array<{
      id: number
      type: string
      source: string | null
      session_id: string | null
      is_pinned: number | null
    }> = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as (typeof rows)[0])
    }
    stmt.free()

    for (const row of rows) {
      const nextType = normalizeMemoryType(row.type)
      const nextSource: MemorySource = (row.source as MemorySource | null) ?? 'manual'
      if (nextType !== row.type || !row.source) {
        const updateStmt = this.db.prepare('UPDATE memories SET type = ?, source = ? WHERE id = ?')
        updateStmt.run([nextType, nextSource, row.id])
        updateStmt.free()
      }
    }
  }

  // --- Settings delegation ---

  async getSettings(): Promise<SettingsRecord> {
    return this.settingsRepo.getSettings()
  }

  async updateSettings(input: Partial<SettingsRecord>): Promise<SettingsRecord> {
    return this.settingsRepo.updateSettings(input)
  }

  async updateRuntimeSetting(sessionId: string, key: string, value?: string): Promise<void> {
    if (value === undefined) {
      return this.runtimeStateRepo.updateRuntimeValue(this.defaultSessionId, sessionId.replace(/^runtime_/, ''), key)
    }
    return this.runtimeStateRepo.updateRuntimeValue(sessionId, key.replace(/^runtime_/, ''), value)
  }

  // --- Messages delegation ---

  async listMessages(sessionId = this.defaultSessionId, limit = 80): Promise<MessageRecord[]> {
    return this.messageRepo.listMessages(sessionId, limit)
  }

  async listAllMessages(sessionId = this.defaultSessionId): Promise<MessageRecord[]> {
    return this.messageRepo.listAllMessages(sessionId)
  }

  async createMessage(input: {
    sessionId: string
    role: MessageRecord['role']
    content: string
    segments: string[]
    topicType: TopicType | null
    isProactive: boolean
  }): Promise<MessageRecord> {
    return this.messageRepo.createMessage(input)
  }

  async updateMessageSegments(messageId: number, segments: string[]): Promise<void> {
    return this.messageRepo.updateMessageSegments(messageId, segments)
  }

  async clearSessionMessages(sessionId = this.defaultSessionId): Promise<void> {
    return this.messageRepo.clearSessionMessages(sessionId)
  }

  async clearAllMessages(): Promise<void> {
    return this.messageRepo.clearAllMessages()
  }

  // --- Memory delegation (unchanged MemoryStore) ---

  async listMemories(options?: {
    sessionId?: string | null
    includeGlobal?: boolean
    limit?: number
    types?: MemoryType[]
    sources?: MemorySource[]
    query?: string
  }): Promise<MemoryRecord[]> {
    return this.memoryStore.list(options)
  }

  async addMemory(input: {
    type: MemoryType
    content: string
    weight: number
    isPinned?: boolean
    sessionId?: string | null
    source?: MemorySource
    metadata?: MemoryMetadata | null
  }): Promise<MemoryRecord> {
    return this.memoryStore.add({
      type: input.type,
      content: input.content,
      weight: input.weight,
      isPinned: Boolean(input.isPinned),
      sessionId: input.sessionId ?? null,
      source: input.source ?? 'manual',
      metadata: input.metadata ?? null
    })
  }

  async updateMemory(
    id: number,
    input: Partial<
      Pick<MemoryRecord, 'content' | 'weight' | 'type' | 'sessionId' | 'source' | 'isPinned' | 'metadata'>
    >
  ): Promise<void> {
    await this.memoryStore.update(id, input)
  }

  async findRecentSummary(sessionId: string): Promise<MemoryRecord | null> {
    return this.memoryStore.findRecentSummary(sessionId)
  }

  async upsertRecentSummary(input: {
    sessionId: string
    content: string
    weight: number
  }): Promise<MemoryRecord> {
    return this.memoryStore.upsertRecentSummary(input)
  }

  async deleteMemory(id: number): Promise<void> {
    await this.memoryStore.delete(id)
  }

  async deleteMemories(ids: number[]): Promise<void> {
    await this.memoryStore.deleteMany(ids)
  }

  async clearSessionChatMemories(sessionId: string): Promise<void> {
    await this.memoryStore.clearSessionChatMemories(sessionId)
  }

  async clearAllChatMemories(): Promise<void> {
    await this.memoryStore.clearAllChatMemories()
  }

  async findMemories(options: {
    sessionId?: string | null
    types?: MemoryType[]
  }): Promise<MemoryRecord[]> {
    return this.memoryStore.list(options)
  }

  // --- Feedback delegation ---

  async createFeedback(input: {
    messageId: number
    feedbackType: FeedbackType
    topicType: TopicType | null
    context?: FeedbackRecord['context']
  }): Promise<FeedbackRecord> {
    return this.feedbackRepo.createFeedback(input)
  }

  async listFeedback(sessionId = this.defaultSessionId, limit = 20): Promise<FeedbackRecord[]> {
    return this.feedbackRepo.listFeedback(sessionId, limit)
  }

  async listAllFeedback(sessionId = this.defaultSessionId): Promise<FeedbackRecord[]> {
    return this.feedbackRepo.listAllFeedback(sessionId)
  }

  // --- Proactive events delegation ---

  async createProactiveEvent(input: {
    sessionId: string
    eventType: string
    score: number | null
    breakdown: unknown
    decision: ProactiveDecision
    reason: string
  }): Promise<ProactiveEventRecord> {
    return this.proactiveEventRepo.createProactiveEvent(input)
  }

  async getLatestProactiveEvent(sessionId = this.defaultSessionId): Promise<ProactiveEventRecord | null> {
    return this.proactiveEventRepo.getLatestProactiveEvent(sessionId)
  }

  async listProactiveEvents(sessionId = this.defaultSessionId): Promise<ProactiveEventRecord[]> {
    return this.proactiveEventRepo.listEvents(sessionId)
  }

  async clearSessionProactiveEvents(sessionId = this.defaultSessionId): Promise<void> {
    return this.proactiveEventRepo.clearSessionEvents(sessionId)
  }

  // --- Runtime state delegation ---

  async getRuntimeState(sessionId = this.defaultSessionId): Promise<RuntimeState> {
    return this.runtimeStateRepo.getRuntimeState(sessionId)
  }

  async clearSessionRuntimeState(sessionId = this.defaultSessionId): Promise<void> {
    return this.runtimeStateRepo.clearSessionRuntimeState(sessionId)
  }

  async getTopicWeights(sessionId = this.defaultSessionId): Promise<Record<TopicType, number>> {
    return this.runtimeStateRepo.getTopicWeights(sessionId)
  }

  async updateTopicWeight(sessionId: string, topicType: TopicType, delta: number): Promise<void> {
    return this.runtimeStateRepo.updateTopicWeight(sessionId, topicType, delta)
  }

  async setUserState(userState: RuntimeState['userState'], sessionId = this.defaultSessionId): Promise<RuntimeState> {
    return this.runtimeStateRepo.setUserState(sessionId, userState)
  }

  async clearCooldown(sessionId = this.defaultSessionId): Promise<RuntimeState> {
    return this.runtimeStateRepo.clearCooldown(sessionId)
  }

  async markUserInteraction(sessionId = this.defaultSessionId): Promise<void> {
    return this.runtimeStateRepo.markUserInteraction(sessionId)
  }

  async markProactiveMessage(sessionId: string, topicType: TopicType): Promise<void> {
    return this.runtimeStateRepo.markProactiveMessage(sessionId, topicType)
  }

  async updateConversationalEnergy(sessionId: string, delta: number): Promise<void> {
    return this.runtimeStateRepo.updateConversationalEnergy(sessionId, delta)
  }

  async updateTopicInterest(sessionId: string, delta: number): Promise<void> {
    return this.runtimeStateRepo.updateTopicInterest(sessionId, delta)
  }

  async updateDesireToTalk(sessionId: string, delta: number): Promise<void> {
    return this.runtimeStateRepo.updateDesireToTalk(sessionId, delta)
  }

  async applyFeedback(input: {
    sessionId: string
    messageId: number
    feedbackType: FeedbackType
    topicType: TopicType | null
    context?: FeedbackRecord['context']
  }): Promise<FeedbackRecord> {
    return this.runtimeStateRepo.applyFeedback(input, this.feedbackRepo, this.memoryStore)
  }

  async getMessageById(messageId: number): Promise<MessageRecord | null> {
    return this.messageRepo.getMessageById(messageId)
  }
}
