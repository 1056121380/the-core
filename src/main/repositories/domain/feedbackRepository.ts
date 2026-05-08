import type { Database } from 'sql.js'
import type { FeedbackContext, FeedbackRecord, FeedbackType, TopicType } from '@shared/types'

function mapFeedback(row: {
  id: number
  message_id: number
  feedback_type: string
  topic_type: string | null
  context_json: string | null
  created_at: string
}): FeedbackRecord {
  return {
    id: Number(row.id),
    messageId: Number(row.message_id),
    feedbackType: row.feedback_type as FeedbackType,
    topicType: (row.topic_type as TopicType | null) ?? null,
    context: row.context_json ? (JSON.parse(row.context_json) as FeedbackContext) : null,
    createdAt: row.created_at
  }
}

export class FeedbackRepository {
  constructor(
    private readonly db: Database,
    private readonly persist: () => Promise<void>
  ) {}

  async createFeedback(input: {
    messageId: number
    feedbackType: FeedbackType
    topicType: TopicType | null
    context?: FeedbackContext | null
  }): Promise<FeedbackRecord> {
    const createdAt = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO feedback (message_id, feedback_type, topic_type, context_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run([input.messageId, input.feedbackType, input.topicType, JSON.stringify(input.context ?? null), createdAt])
    stmt.free()
    await this.persist()

    const fetchStmt = this.db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 1')
    const row = fetchStmt.step() ? (fetchStmt.getAsObject() as never) : null
    fetchStmt.free()
    if (!row) {
      throw new Error('Failed to read inserted feedback.')
    }
    return mapFeedback(row)
  }

  async listFeedback(sessionId: string, limit: number): Promise<FeedbackRecord[]> {
    const stmt = this.db.prepare(`
      SELECT feedback.*
      FROM feedback
      INNER JOIN messages ON messages.id = feedback.message_id
      WHERE messages.session_id = ?
      ORDER BY feedback.id DESC
      LIMIT ?
    `)
    stmt.bind([sessionId, limit])
    const rows: FeedbackRecord[] = []
    while (stmt.step()) {
      rows.push(mapFeedback(stmt.getAsObject() as never))
    }
    stmt.free()
    return rows
  }

  async listAllFeedback(sessionId: string): Promise<FeedbackRecord[]> {
    const stmt = this.db.prepare(`
      SELECT feedback.*
      FROM feedback
      INNER JOIN messages ON messages.id = feedback.message_id
      WHERE messages.session_id = ?
      ORDER BY feedback.id ASC
    `)
    stmt.bind([sessionId])
    const rows: FeedbackRecord[] = []
    while (stmt.step()) {
      rows.push(mapFeedback(stmt.getAsObject() as never))
    }
    stmt.free()
    return rows
  }
}
