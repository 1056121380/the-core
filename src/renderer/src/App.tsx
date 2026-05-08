import { useEffect, useMemo, useState } from 'react'
import type {
  AppSnapshot,
  AutoTestReport,
  ChatExportResult,
  DebugLogEntry,
  MemoryType,
  MessageRecord,
  SettingsRecord,
  TypingEventPayload,
  UserState
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { AutoTestPanel } from '@renderer/components/AutoTestPanel'
import { ChatPanel } from '@renderer/components/ChatPanel'
import { DebugPanel } from '@renderer/components/DebugPanel'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { MemoryPanel } from '@renderer/components/MemoryPanel'
import { SettingsPanel } from '@renderer/components/SettingsPanel'
import { StatePanel } from '@renderer/components/StatePanel'

const DESKTOP_SESSION_ID = 'desktop_default'

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([])
  const [autoTestReport, setAutoTestReport] = useState<AutoTestReport | null>(null)
  const [isRunningAutoTest, setIsRunningAutoTest] = useState(false)
  const [chatExportResult, setChatExportResult] = useState<ChatExportResult | null>(null)
  const [isExportingChat, setIsExportingChat] = useState(false)
  const [logPath, setLogPath] = useState('')
  const [databasePath, setDatabasePath] = useState('')
  const [memoryFilePath, setMemoryFilePath] = useState('')
  const [settingsDraft, setSettingsDraft] = useState<SettingsRecord>(DEFAULT_SETTINGS)
  const [input, setInput] = useState('')
  const [isChecking, setIsChecking] = useState(false)
  const [typingState, setTypingState] = useState<TypingEventPayload['state']>('idle')
  const [currentTimeLabel, setCurrentTimeLabel] = useState(
    new Date().toLocaleString('zh-CN', { hour12: false })
  )

  const refreshSnapshot = async (): Promise<void> => {
    const [next, logState, storageInfo] = await Promise.all([
      window.assistantApi.getSnapshot(DESKTOP_SESSION_ID),
      window.assistantApi.getDebugLogs(),
      window.assistantApi.getStorageInfo()
    ])
    setSnapshot(next)
    setSettingsDraft(next.settings)
    setDebugLogs(logState.entries)
    setLogPath(logState.logPath)
    setDatabasePath(storageInfo.databasePath)
    setMemoryFilePath(storageInfo.memoryFilePath)
  }

  useEffect(() => {
    void refreshSnapshot()
    const timer = window.setInterval(() => {
      setCurrentTimeLabel(new Date().toLocaleString('zh-CN', { hour12: false }))
    }, 1000)
    const unsubscribe = window.assistantApi.onAssistantSegment((payload) => {
      if (payload.sessionId !== DESKTOP_SESSION_ID) return

      setSnapshot((current) => {
        if (!current) return current
        const existing = current.messages.find((message) => message.id === payload.messageId)
        const nextMessages = existing
          ? current.messages.map((message) =>
              message.id === payload.messageId
                ? {
                    ...message,
                    segments: [...message.segments, payload.segment],
                    content: [...message.segments, payload.segment].join('\n')
                  }
                : message
            )
          : current.messages.concat({
              id: payload.messageId,
              sessionId: payload.sessionId,
              role: 'assistant',
              content: payload.segment,
              segments: [payload.segment],
              topicType: payload.topicType,
              isProactive: true,
              createdAt: new Date().toISOString()
            } satisfies MessageRecord)
        return { ...current, messages: nextMessages }
      })

      if (payload.isFinal) void refreshSnapshot()
    })

    const unsubscribeTyping = window.assistantApi.onAssistantTyping((payload) => {
      if (payload.sessionId !== DESKTOP_SESSION_ID) return
      setTypingState(payload.state)
    })

    return () => {
      window.clearInterval(timer)
      unsubscribe()
      unsubscribeTyping()
    }
  }, [])

  const feedback = snapshot?.feedback ?? []
  const messages = snapshot?.messages ?? []
  const sortedMessages = useMemo(() => messages, [messages])

  const sendMessage = async (): Promise<void> => {
    if (!input.trim()) return
    const content = input.trim()
    setInput('')
    try {
      await window.assistantApi.handleIncomingMessage(DESKTOP_SESSION_ID, content)
    } catch (error) {
      console.error('Failed to send message:', error)
    } finally {
      await refreshSnapshot()
    }
  }

  const runManualCheck = async (): Promise<void> => {
    setIsChecking(true)
    try {
      await window.assistantApi.runProactiveCheck(DESKTOP_SESSION_ID)
      await refreshSnapshot()
    } finally {
      setIsChecking(false)
    }
  }

  const clearChat = async (): Promise<void> => {
    await window.assistantApi.clearChatSession(DESKTOP_SESSION_ID)
    setChatExportResult(null)
    await refreshSnapshot()
  }

  const exportChat = async (): Promise<void> => {
    setIsExportingChat(true)
    try {
      const result = await window.assistantApi.exportChatSession(DESKTOP_SESSION_ID)
      setChatExportResult(result)
      await refreshSnapshot()
    } finally {
      setIsExportingChat(false)
    }
  }

  const setUserState = async (state: UserState): Promise<void> => {
    await window.assistantApi.setUserState(state)
    await refreshSnapshot()
  }

  const clearCooldown = async (): Promise<void> => {
    await window.assistantApi.clearCooldown()
    await refreshSnapshot()
  }

  const addMemory = async (payload: {
    type: MemoryType
    content: string
    weight: number
    isPinned?: boolean
    sessionId?: string | null
    metadata?: AppSnapshot['memories'][number]['metadata']
  }): Promise<void> => {
    await window.assistantApi.addMemory(payload)
    await refreshSnapshot()
  }

  const deleteMemory = async (id: number): Promise<void> => {
    await window.assistantApi.deleteMemory(id)
    await refreshSnapshot()
  }

  const setMemoryPinned = async (id: number, isPinned: boolean): Promise<void> => {
    await window.assistantApi.setMemoryPinned(id, isPinned)
    await refreshSnapshot()
  }

  const clearSessionChatMemories = async (): Promise<void> => {
    await window.assistantApi.clearSessionChatMemories(DESKTOP_SESSION_ID)
    await refreshSnapshot()
  }

  const clearAllChatMemories = async (): Promise<void> => {
    await window.assistantApi.clearAllChatMemories()
    await refreshSnapshot()
  }

  const saveSettings = async (nextSettings = settingsDraft): Promise<void> => {
    await window.assistantApi.updateSettings(nextSettings)
    await refreshSnapshot()
  }

  const updateQuickSettings = async (patch: Partial<SettingsRecord>): Promise<void> => {
    const nextSettings = { ...settingsDraft, ...patch }
    setSettingsDraft(nextSettings)
    await window.assistantApi.updateSettings(patch)
    await refreshSnapshot()
  }

  const submitFeedback = async (
    message: MessageRecord,
    type: 'positive' | 'neutral' | 'negative'
  ): Promise<void> => {
    await window.assistantApi.submitFeedback({
      sessionId: DESKTOP_SESSION_ID,
      messageId: message.id,
      feedbackType: type,
      topicType: message.topicType
    })
    await refreshSnapshot()
  }

  const runAutoQa = async (): Promise<void> => {
    setIsRunningAutoTest(true)
    try {
      const report = await window.assistantApi.runAutoQa()
      setAutoTestReport(report)
      await refreshSnapshot()
    } finally {
      setIsRunningAutoTest(false)
    }
  }

  if (!snapshot) {
    return <main className="app-shell loading">加载中...</main>
  }

  return (
    <main className="app-shell">
      <div className="main-column">
        <header className="hero">
          <div>
            <span className="eyebrow">桌面纯文本主动聊天助手</span>
            <h1>主动聊天桌面助手 MVP</h1>
            <p>聚焦主动触发、冷却、记忆、人设、情绪和分段文本输出。不接语音，也不做系统级弹窗。</p>
          </div>
        </header>
        <ErrorBoundary title="聊天面板">
          <ChatPanel
            messages={sortedMessages}
            feedback={feedback}
            input={input}
            isChecking={isChecking}
            settings={settingsDraft}
            isExporting={isExportingChat}
            exportResult={chatExportResult}
            typingState={typingState}
            onInputChange={setInput}
            onSend={() => void sendMessage()}
            onClearChat={() => void clearChat()}
            onExportChat={() => void exportChat()}
            onManualCheck={() => void runManualCheck()}
            onQuickSettingsChange={(patch) => void updateQuickSettings(patch)}
            onFeedback={(message, type) => void submitFeedback(message, type)}
          />
        </ErrorBoundary>
      </div>
      <aside className="side-column">
        <ErrorBoundary title="状态面板">
          <StatePanel
            runtimeState={snapshot.runtimeState}
            currentTimeLabel={currentTimeLabel}
            onSetUserState={(state) => void setUserState(state)}
            onClearCooldown={() => void clearCooldown()}
          />
        </ErrorBoundary>
        <ErrorBoundary title="记忆面板">
          <MemoryPanel
            memories={snapshot.memories}
            memoryFilePath={memoryFilePath}
            onAddMemory={(payload) => void addMemory(payload)}
            onDeleteMemory={(id) => void deleteMemory(id)}
            onSetMemoryPinned={(id, isPinned) => void setMemoryPinned(id, isPinned)}
            onClearSessionChatMemories={() => void clearSessionChatMemories()}
            onClearAllChatMemories={() => void clearAllChatMemories()}
          />
        </ErrorBoundary>
        <ErrorBoundary title="设置面板">
          <SettingsPanel draft={settingsDraft} onDraftChange={setSettingsDraft} onSave={(draft) => void saveSettings(draft)} />
        </ErrorBoundary>
        <ErrorBoundary title="AI 自动测试">
          <AutoTestPanel report={autoTestReport} isRunning={isRunningAutoTest} onRun={() => void runAutoQa()} />
        </ErrorBoundary>
        <ErrorBoundary title="调试面板">
          <DebugPanel
            latestEvent={snapshot.latestEvent}
            feedback={snapshot.feedback}
            debugLogs={debugLogs}
            logPath={logPath}
            databasePath={databasePath}
            memoryFilePath={memoryFilePath}
            memoryDebug={snapshot.memoryDebug}
          />
        </ErrorBoundary>
      </aside>
    </main>
  )
}
