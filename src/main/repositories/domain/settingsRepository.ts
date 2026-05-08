import type { Database } from 'sql.js'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { SettingsRecord } from '@shared/types'

const SETTING_KEYS: Array<keyof SettingsRecord> = [
  'threshold',
  'dailyLimit',
  'cooldownHoursAfterReject',
  'maxSegments',
  'checkIntervalMinutes',
  'minMinutesBetweenProactive',
  'activeConversationBlockMinutes',
  'proactiveRandomness',
  'proactiveDesireBias',
  'memoryAutoStoreEnabled',
  'memoryImportanceThreshold',
  'enableLlmSelfCheck',
  'mockMode',
  'llmEnabled',
  'llmApiKey',
  'llmBaseUrl',
  'llmModel',
  'identityProfile',
  'personaPrompt',
  'habitProfile',
  'assistantTimezone',
  'assistantLocation',
  'weatherSummary',
  'quietHoursStart',
  'quietHoursEnd',
  'enableEnvironmentAwareness',
  'enableEmotionModel',
  'enableMotivationModel',
  'enableRelationshipModel',
  'verbalTics',
  'logLevel'
]

function serializeValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value)
  }
  return String(value)
}

export class SettingsRepository {
  constructor(
    private readonly db: Database,
    private readonly persist: () => Promise<void>
  ) {}

  private readValue(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
    stmt.bind([key])
    const row = stmt.step() ? (stmt.getAsObject() as { value?: string }) : null
    stmt.free()
    return row?.value ?? null
  }

  private writeValue(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    stmt.run([key, value])
    stmt.free()
  }

  async seedDefaults(): Promise<void> {
    for (const key of SETTING_KEYS) {
      if (this.readValue(key) == null) {
        this.writeValue(key, serializeValue(DEFAULT_SETTINGS[key]))
      }
    }
    this.writeValue('mockMode', 'false')
    this.writeValue('llmEnabled', 'true')
    await this.persist()
  }

  async getSettings(): Promise<SettingsRecord> {
    const nextSettings: SettingsRecord = { ...DEFAULT_SETTINGS }

    for (const key of SETTING_KEYS) {
      const raw = this.readValue(key)
      if (raw == null) {
        continue
      }

      switch (key) {
        case 'enableEnvironmentAwareness':
        case 'enableEmotionModel':
        case 'enableMotivationModel':
        case 'enableRelationshipModel':
        case 'enableLlmSelfCheck':
        case 'memoryAutoStoreEnabled':
        case 'mockMode':
        case 'llmEnabled':
          nextSettings[key] = (raw === 'true') as SettingsRecord[typeof key]
          break
        case 'threshold':
        case 'dailyLimit':
        case 'cooldownHoursAfterReject':
        case 'maxSegments':
        case 'checkIntervalMinutes':
        case 'minMinutesBetweenProactive':
        case 'activeConversationBlockMinutes':
        case 'proactiveRandomness':
        case 'proactiveDesireBias':
        case 'memoryImportanceThreshold':
        case 'quietHoursStart':
        case 'quietHoursEnd':
          nextSettings[key] = Number(raw) as SettingsRecord[typeof key]
          break
        case 'logLevel':
          nextSettings[key] = (raw === 'warn' || raw === 'error' ? raw : 'info') as SettingsRecord[typeof key]
          break
        case 'verbalTics':
          try {
            nextSettings[key] = JSON.parse(raw) as string[]
          } catch {
            nextSettings[key] = DEFAULT_SETTINGS.verbalTics
          }
          break
        default:
          nextSettings[key] = raw as SettingsRecord[typeof key]
          break
      }
    }

    return {
      ...nextSettings,
      mockMode: false,
      llmEnabled: true
    }
  }

  async updateSettings(input: Partial<SettingsRecord>): Promise<SettingsRecord> {
    for (const [key, value] of Object.entries(input) as Array<[keyof SettingsRecord, SettingsRecord[keyof SettingsRecord]]>) {
      if (value === undefined) {
        continue
      }
      this.writeValue(key, serializeValue(value))
    }
    await this.persist()
    return this.getSettings()
  }

  async updateRuntimeSetting(key: string, value: string): Promise<void> {
    this.writeValue(key, value)
    await this.persist()
  }

  getRuntimeValue(key: string): string | null {
    return this.readValue(key)
  }
}
