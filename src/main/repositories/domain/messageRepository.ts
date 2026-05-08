import type { Database } from 'sql.js'
import type { MessageRecord, TopicType } from '@shared/types'

function mapMessage(row: {
  id: number
  session_id: string
  role: MessageRecord['role']
  content: string
  segments_json: string | null
  topic_type: string | null
  is_proactive: number
  created_at: string
}): MessageRecord {
  const segments = row.segments_json ? (JSON.parse(row.segments_json) as string[]) : []
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    segments,
    topicType: (row.topic_type as TopicType | null) ?? null,
    isProactive: Boolean(row.is_proactive),
    createdAt: row.created_at
  }
}

export class MessageRepository {
  constructor(
    private readonly db: Database,
    private readonly persist: () => Promise<void>
  ) {}

  async listMessages(sessionId: string, limit: number): Promise<MessageRecord[]> {
    const stmt = this.db.prepare(`
      SELECT *
      FROM (
        SELECT *
        FROM messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
      ORDER BY id ASC
    `)
    stmt.bind([sessionId, limit])
    const rows: MessageRecord[] = []
    while (stmt.step()) {
      rows.push(mapMessage(stmt.getAsObject() as never))
    }
    stmt.free()
    return rows
  }

  async listAllMessages(sessionId: string): Promise<MessageRecord[]> {
    const stmt = this.db.prepare(`
      SELECT *
      FROM messages
      WHERE session_id = ?
      ORDER BY id ASC
    `)
    stmt.bind([sessionId])
    const rows: MessageRecord[] = []
    while (stmt.step()) {
      rows.push(mapMessage(stmt.getAsObject() as never))
    }
    stmt.free()
    return rows
  }

  async createMessage(input: {
    sessionId: string
    role: MessageRecord['role']
    content: string
    segments: string[]
    topicType: TopicType | null
    isProactive: boolean
  }): Promise<MessageRecord> {
    const createdAt = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        session_id,
        role,
        content,
        segments_json,
        topic_type,
        is_proactive,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run([
      input.sessionId,
      input.role,
      input.content,
      JSON.stringify(input.segments),
      input.topicType,
      input.isProactive ? 1 : 0,
      createdAt
    ])
    stmt.free()
    await this.persist()

    const fetchStmt = this.db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 1')
    const row = fetchStmt.step() ? (fetchStmt.getAsObject() as never) : null
    fetchStmt.free()
    if (!row) {
      throw new Error('Failed to read inserted message.')
    }
    return mapMessage(row)
  }

  async updateMessageSegments(messageId: number, segments: string[]): Promise<void> {
    const stmt = this.db.prepare('UPDATE messages SET content = ?, segments_json = ? WHERE id = ?')
    stmt.run([segments.join('\n'), JSON.stringify(segments), messageId])
    stmt.free()
    await this.persist()
  }

  async getMessageById(messageId: number): Promise<MessageRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ? LIMIT 1')
    stmt.bind([messageId])
    const row = stmt.step() ? (stmt.getAsObject() as never) : null
    stmt.free()
    return row ? mapMessage(row) : null
  }

  async getUserActivityHistogram(sessionId?: string): Promise<number[]> {
    const histogram = Array.from({ length: 24 }, () => 0)
    const query = sessionId
      ? 'SELECT created_at FROM messages WHERE role = ? AND session_id = ?'
      : 'SELECT created_at FROM messages WHERE role = ?'
    const stmt = this.db.prepare(query)
    stmt.bind(sessionId ? ['user', sessionId] : ['user'])
    while (stmt.step()) {
      const row = stmt.getAsObject() as { created_at?: string }
      if (!row.created_at) {
        continue
      }
      const hour = new Date(row.created_at).getHours()
      histogram[hour] += 1
    }
    stmt.free()
    return histogram
  }

  async clearSessionMessages(sessionId: string): Promise<void> {
    const feedbackStmt = this.db.prepare(`
      DELETE FROM feedback
      WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)
    `)
    feedbackStmt.run([sessionId])
    feedbackStmt.free()

    const messageStmt = this.db.prepare('DELETE FROM messages WHERE session_id = ?')
    messageStmt.run([sessionId])
    messageStmt.free()
    await this.persist()
  }

  async clearAllMessages(): Promise<void> {
    this.db.run('DELETE FROM feedback')
    this.db.run('DELETE FROM messages')
    await this.persist()
  }
}
