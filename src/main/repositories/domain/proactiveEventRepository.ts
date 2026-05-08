import type { Database } from 'sql.js'
import type { ProactiveDecision, ProactiveEventRecord, ScoreBreakdownItem } from '@shared/types'

function mapEvent(row: {
  id: number
  session_id: string
  event_type: string
  score: number | null
  breakdown_json: string | null
  decision: string
  reason: string
  created_at: string
}): ProactiveEventRecord {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    eventType: row.event_type,
    score: row.score == null ? null : Number(row.score),
    breakdown: row.breakdown_json ? (JSON.parse(row.breakdown_json) as ScoreBreakdownItem[]) : [],
    decision: row.decision as ProactiveDecision,
    reason: row.reason,
    createdAt: row.created_at
  }
}

export class ProactiveEventRepository {
  constructor(
    private readonly db: Database,
    private readonly persist: () => Promise<void>
  ) {}

  async createProactiveEvent(input: {
    sessionId: string
    eventType: string
    score: number | null
    breakdown: unknown
    decision: ProactiveDecision
    reason: string
  }): Promise<ProactiveEventRecord> {
    const createdAt = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO proactive_events (
        session_id,
        event_type,
        score,
        breakdown_json,
        decision,
        reason,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run([
      input.sessionId,
      input.eventType,
      input.score,
      JSON.stringify(input.breakdown),
      input.decision,
      input.reason,
      createdAt
    ])
    stmt.free()
    await this.persist()

    const fetchStmt = this.db.prepare('SELECT * FROM proactive_events ORDER BY id DESC LIMIT 1')
    const row = fetchStmt.step() ? (fetchStmt.getAsObject() as never) : null
    fetchStmt.free()
    if (!row) {
      throw new Error('Failed to read inserted proactive event.')
    }
    return mapEvent(row)
  }

  async getLatestProactiveEvent(sessionId: string): Promise<ProactiveEventRecord | null> {
    const stmt = this.db.prepare(`
      SELECT *
      FROM proactive_events
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    stmt.bind([sessionId])
    const row = stmt.step() ? (stmt.getAsObject() as never) : null
    stmt.free()
    return row ? mapEvent(row) : null
  }

  async listEvents(sessionId: string): Promise<ProactiveEventRecord[]> {
    const stmt = this.db.prepare(`
      SELECT *
      FROM proactive_events
      WHERE session_id = ?
      ORDER BY id ASC
    `)
    stmt.bind([sessionId])
    const rows: ProactiveEventRecord[] = []
    while (stmt.step()) {
      rows.push(mapEvent(stmt.getAsObject() as never))
    }
    stmt.free()
    return rows
  }

  async clearSessionEvents(sessionId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM proactive_events WHERE session_id = ?')
    stmt.run([sessionId])
    stmt.free()
    await this.persist()
  }
}
