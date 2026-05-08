// ============================================================
// 主进程入口 - 重构版
// 使用新的数字人引擎架构
// ============================================================
//
// 架构说明：
// ┌─────────────────────────────────────────────────────────────┐
// │                    输入层（可插拔）                          │
// │  MessageGateway (微信 / 企业微信 / 桌面 / Telegram)           │
// └──────────────────────────┬────────────────────────────────┘
//                            │
// ┌──────────────────────────▼────────────────────────────────┐
// │                    核心层（稳定）                            │
// │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
// │  │ Identity    │  │ MemoryGraph │  │ Relationship│         │
// │  │ 身份引擎    │  │ 记忆图谱    │  │ 关系引擎    │         │
// │  └─────────────┘  └─────────────┘  └─────────────┘         │
// │                      ↓                                      │
// │              DialogEngine（对话引擎）                        │
// │                      ↓                                      │
// │             ProactiveEngine（主动引擎）                      │
// └──────────────────────────┬────────────────────────────────┘
//                            │
// ┌──────────────────────────▼────────────────────────────────┐
// │                    输出层（可插拔）                          │
// │  TextOutput │ ImageOutput │ TTSOutput │ AvatarOutput        │
// └─────────────────────────────────────────────────────────────┘
// ============================================================

import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { AppRepository } from '@main/repositories/database'
import { logger } from '@main/services/logger'
import { ProactiveEngine } from '@main/engine/proactiveEngine'
import { identityEngine } from '@main/engine/identityEngine'
import type { FeedbackType, MemoryType, SettingsRecord, TopicType, UserState } from '@shared/types'
import { createLLMAdapter, createImageAdapter, createTTSAdapter, createChannelAdapter } from '@main/adapters'

// --- 新架构引擎实例 ---
let mainWindow: BrowserWindow | null = null
const repository = new AppRepository()

// 使用新架构的主动引擎
const proactiveEngine = new ProactiveEngine(repository, () => mainWindow)

// --- 新架构特性初始化 ---
async function initializeNewArchitecture(): Promise<void> {
  // 1. 加载人设配置
  try {
    identityEngine.loadFromFile()
    logger.info('app', 'Identity engine loaded.', { path: identityEngine.getLoadedPath() })
  } catch (error) {
    logger.warn('app', 'Failed to load identity config, using defaults.', { error: String(error) })
  }

  // 2. 初始化 Adapter（预留插件位置）
  const settings = await repository.getSettings()
  const llmAdapter = createLLMAdapter(settings)
  const imageAdapter = createImageAdapter()
  const ttsAdapter = createTTSAdapter()
  const channelAdapter = createChannelAdapter()

  logger.info('app', 'Adapters initialized.', {
    llmAvailable: llmAdapter.isAvailable(),
    imageAvailable: imageAdapter.isAvailable(),
    ttsAvailable: ttsAdapter.isAvailable()
  })
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: '数字人助手 - 桌面版',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // 核心 API（保持向后兼容）
  ipcMain.handle('app:snapshot', async (_event, sessionId?: string) =>
    proactiveEngine.getSnapshot(sessionId ?? proactiveEngine.getDefaultSessionId())
  )
  ipcMain.handle('chat:send', async (_event, payload: { sessionId: string; content: string }) =>
    proactiveEngine.handleIncomingMessage(payload.sessionId, payload.content)
  )
  ipcMain.handle('chat:clear', async (_event, sessionId?: string) =>
    proactiveEngine.clearChatSession(sessionId ?? proactiveEngine.getDefaultSessionId())
  )
  ipcMain.handle('proactive:check', async (_event, sessionId?: string) =>
    proactiveEngine.checkProactive(sessionId ?? proactiveEngine.getDefaultSessionId(), 'manual')
  )

  ipcMain.handle('state:set', async (_event, userState: UserState) => proactiveEngine.setUserState(userState))
  ipcMain.handle('state:clear-cooldown', async () => proactiveEngine.clearCooldown())

  ipcMain.handle('memory:add', async (_event, payload: {
    type: MemoryType
    content: string
    weight: number
    isPinned?: boolean
    sessionId?: string | null
    metadata?: { deadline?: string | null; taskStatus?: 'open' | 'done' | 'archived' } | null
  }) => proactiveEngine.addMemory(payload as any))

  ipcMain.handle('memory:delete', async (_event, id: number) => proactiveEngine.deleteMemory(id))
  ipcMain.handle('memory:set-pinned', async (_event, payload: { id: number; isPinned: boolean }) =>
    proactiveEngine.setMemoryPinned(payload.id, payload.isPinned)
  )

  ipcMain.handle('settings:update', async (_event, payload: Partial<SettingsRecord>) =>
    proactiveEngine.updateSettings(payload)
  )

  ipcMain.handle('feedback:submit', async (_event, payload: { sessionId: string; messageId: number; feedbackType: FeedbackType; topicType: TopicType | null }) =>
    proactiveEngine.submitFeedback(payload)
  )

  ipcMain.handle('assistant:interrupt', async () => proactiveEngine.interruptSegmentedOutput())

  ipcMain.handle('debug:logs', async () => ({
    logPath: logger.getLogPath(),
    entries: logger.readRecent()
  }))

  // --- 新架构扩展 API ---
  ipcMain.handle('identity:reload', async (_event, filePath?: string) => {
    if (filePath) {
      identityEngine.loadFromFile(filePath)
    } else {
      identityEngine.loadFromFile()
    }
    return { name: identityEngine.getProfile().name, loaded: identityEngine.isLoaded() }
  })

  ipcMain.handle('identity:summary', async () => {
    return identityEngine.getSummary()
  })

  ipcMain.handle('adapter:status', async () => {
    const settings = await repository.getSettings()
    return {
      llm: createLLMAdapter(settings).isAvailable(),
      image: createImageAdapter().isAvailable(),
      tts: createTTSAdapter().isAvailable()
    }
  })
}

app.whenReady().then(async () => {
  logger.init()
  logger.info('app', 'Application starting (new architecture).')

  await repository.init()
  await initializeNewArchitecture()

  registerIpc()
  await createWindow()
  await proactiveEngine.startScheduler()

  logger.info('app', 'Application ready.')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
