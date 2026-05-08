import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { DebugLogEntry, LogLevel } from '@shared/types'

const MAX_LOG_LINES = 80
const MAX_LOG_BYTES = 5 * 1024 * 1024
const LOG_PRIORITY: Record<LogLevel, number> = {
  info: 1,
  warn: 2,
  error: 3
}

class LoggerService {
  private logPath: string | null = null
  private currentLevel: LogLevel = 'info'

  init(): string {
    if (this.logPath) {
      return this.logPath
    }

    const logDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    this.logPath = path.join(logDir, 'assistant.log')
    return this.logPath
  }

  getLogPath(): string {
    return this.logPath ?? this.init()
  }

  setLevel(level: LogLevel): void {
    this.currentLevel = level
  }

  info(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.write({ level: 'info', scope, message, meta, timestamp: new Date().toISOString() })
  }

  warn(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.write({ level: 'warn', scope, message, meta, timestamp: new Date().toISOString() })
  }

  error(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.write({ level: 'error', scope, message, meta, timestamp: new Date().toISOString() })
  }

  readRecent(limit = MAX_LOG_LINES): DebugLogEntry[] {
    const logPath = this.getLogPath()
    if (!fs.existsSync(logPath)) {
      return []
    }

    const lines = fs
      .readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-Math.max(limit, 1))

    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as DebugLogEntry]
      } catch {
        return []
      }
    })
  }

  private shouldWrite(level: LogLevel): boolean {
    return LOG_PRIORITY[level] >= LOG_PRIORITY[this.currentLevel]
  }

  private rotateIfNeeded(logPath: string): void {
    if (!fs.existsSync(logPath)) {
      return
    }
    const stat = fs.statSync(logPath)
    if (stat.size < MAX_LOG_BYTES) {
      return
    }

    const rotatedPath = `${logPath}.1`
    if (fs.existsSync(rotatedPath)) {
      fs.rmSync(rotatedPath, { force: true })
    }
    fs.renameSync(logPath, rotatedPath)
  }

  private write(entry: DebugLogEntry): void {
    if (!this.shouldWrite(entry.level)) {
      return
    }

    const logPath = this.getLogPath()
    this.rotateIfNeeded(logPath)

    const serialized = JSON.stringify({
      ...entry,
      meta: entry.meta ? this.sanitize(entry.meta) : undefined
    })
    fs.appendFileSync(logPath, `${serialized}\n`, 'utf8')
    const summary = `[${entry.level}] ${entry.scope}: ${entry.message}`
    if (entry.level === 'error') {
      console.error(summary, entry.meta ?? '')
    } else if (entry.level === 'warn') {
      console.warn(summary, entry.meta ?? '')
    } else {
      console.log(summary, entry.meta ?? '')
    }
  }

  private sanitize(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item))
    }

    if (typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (/api[_-]?key|authorization|token/i.test(key)) {
          result[key] = '[redacted]'
        } else if (raw instanceof Error) {
          result[key] = {
            name: raw.name,
            message: raw.message,
            stack: raw.stack
          }
        } else if (typeof raw === 'string' && raw.length > 600) {
          result[key] = `${raw.slice(0, 600)}...`
        } else {
          result[key] = this.sanitize(raw)
        }
      }
      return result
    }

    if (typeof value === 'string' && value.length > 600) {
      return `${value.slice(0, 600)}...`
    }

    return value
  }
}

export const logger = new LoggerService()
