import { contextBridge, ipcRenderer } from 'electron'
import type {
  AutoTestReport,
  AppSnapshot,
  ChatExportResult,
  DebugLogEntry,
  FeedbackType,
  MemoryRecord,
  MemoryType,
  SegmentEventPayload,
  SettingsRecord,
  TopicType,
  TypingEventPayload,
  UserState
} from '@shared/types'

const api = {
  getSnapshot: (sessionId: string): Promise<AppSnapshot> => ipcRenderer.invoke('app:snapshot', sessionId),
  handleIncomingMessage: (sessionId: string, content: string) => ipcRenderer.invoke('chat:send', { sessionId, content }),
  clearChatSession: (sessionId: string) => ipcRenderer.invoke('chat:clear', sessionId),
  exportChatSession: (sessionId: string): Promise<ChatExportResult> => ipcRenderer.invoke('chat:export', sessionId),
  runProactiveCheck: (sessionId: string) => ipcRenderer.invoke('proactive:check', sessionId),
  setUserState: (userState: UserState) => ipcRenderer.invoke('state:set', userState),
  clearCooldown: () => ipcRenderer.invoke('state:clear-cooldown'),
  addMemory: (payload: {
    type: MemoryType
    content: string
    weight: number
    isPinned?: boolean
    sessionId?: string | null
    metadata?: MemoryRecord['metadata']
  }): Promise<MemoryRecord> =>
    ipcRenderer.invoke('memory:add', payload),
  deleteMemory: (id: number) => ipcRenderer.invoke('memory:delete', id),
  setMemoryPinned: (id: number, isPinned: boolean) => ipcRenderer.invoke('memory:set-pinned', { id, isPinned }),
  clearSessionChatMemories: (sessionId: string) => ipcRenderer.invoke('memory:clear-session-chat', sessionId),
  clearAllChatMemories: () => ipcRenderer.invoke('memory:clear-all-chat'),
  updateSettings: (payload: Partial<SettingsRecord>) => ipcRenderer.invoke('settings:update', payload),
  submitFeedback: (payload: { sessionId: string; messageId: number; feedbackType: FeedbackType; topicType: TopicType | null }) =>
    ipcRenderer.invoke('feedback:submit', payload),
  interruptAssistant: () => ipcRenderer.invoke('assistant:interrupt'),
  getDebugLogs: (): Promise<{ logPath: string; entries: DebugLogEntry[] }> => ipcRenderer.invoke('debug:logs'),
  getStorageInfo: (): Promise<{ databasePath: string; logPath: string; memoryFilePath: string }> =>
    ipcRenderer.invoke('debug:storage'),
  runAutoQa: (): Promise<AutoTestReport> => ipcRenderer.invoke('qa:auto-run'),
  onAssistantSegment: (callback: (payload: SegmentEventPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SegmentEventPayload) => callback(payload)
    ipcRenderer.on('assistant:segment', listener)
    return () => ipcRenderer.removeListener('assistant:segment', listener)
  },
  onAssistantTyping: (callback: (payload: TypingEventPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TypingEventPayload) => callback(payload)
    ipcRenderer.on('assistant:typing', listener)
    return () => ipcRenderer.removeListener('assistant:typing', listener)
  }
}

contextBridge.exposeInMainWorld('assistantApi', api)

export type AssistantApi = typeof api
