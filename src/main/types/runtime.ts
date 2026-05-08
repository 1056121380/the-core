import type { MemoryRecord, MessageRecord, RuntimeState, SettingsRecord } from '@shared/types'

export interface ProactiveContext {
  settings: SettingsRecord
  runtimeState: RuntimeState
  recentMessages: MessageRecord[]
  memories: MemoryRecord[]
}
