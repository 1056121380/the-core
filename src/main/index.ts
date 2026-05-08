import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { AppRepository } from '@main/repositories/database'
import { AutoTester } from '@main/services/autoTester'
import { ChatExporter } from '@main/services/chatExporter'
import { logger } from '@main/services/logger'
import { ProactiveEngine } from '@main/services/proactiveEngine'
import type { FeedbackType, MemoryType, SettingsRecord, TopicType, UserState } from '@shared/types'

let mainWindow: BrowserWindow | null = null
const repository = new AppRepository()
const proactiveEngine = new ProactiveEngine(repository, () => mainWindow)
const autoTester = new AutoTester(repository, proactiveEngine)
const chatExporter = new ChatExporter(repository)

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: 'Pure Text Proactive Assistant MVP',
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
  ipcMain.handle('app:snapshot', async (_event, sessionId?: string) =>
    proactiveEngine.getSnapshot(sessionId ?? proactiveEngine.getDefaultSessionId())
  )
  ipcMain.handle('chat:send', async (_event, payload: { sessionId: string; content: string }) =>
    proactiveEngine.handleIncomingMessage(payload.sessionId, payload.content)
  )
  ipcMain.handle('chat:clear', async (_event, sessionId?: string) =>
    proactiveEngine.clearChatSession(sessionId ?? proactiveEngine.getDefaultSessionId())
  )
  ipcMain.handle('chat:export', async (_event, sessionId?: string) =>
    chatExporter.exportSession(sessionId ?? proactiveEngine.getDefaultSessionId())
  )
  ipcMain.handle('proactive:check', async (_event, sessionId?: string) =>
    proactiveEngine.checkProactive(sessionId ?? proactiveEngine.getDefaultSessionId(), 'manual')
  )
  ipcMain.handle('state:set', async (_event, userState: UserState) => proactiveEngine.setUserState(userState))
  ipcMain.handle('state:clear-cooldown', async () => proactiveEngine.clearCooldown())
  ipcMain.handle(
    'memory:add',
    async (
      _event,
      payload: {
        type: MemoryType
        content: string
        weight: number
        isPinned?: boolean
        sessionId?: string | null
        metadata?: { deadline?: string | null; taskStatus?: 'open' | 'done' | 'archived' } | null
      }
    ) => proactiveEngine.addMemory(payload)
  )
  ipcMain.handle('memory:delete', async (_event, id: number) => proactiveEngine.deleteMemory(id))
  ipcMain.handle('memory:set-pinned', async (_event, payload: { id: number; isPinned: boolean }) =>
    proactiveEngine.setMemoryPinned(payload.id, payload.isPinned)
  )
  ipcMain.handle('memory:clear-session-chat', async (_event, sessionId?: string) =>
    proactiveEngine.clearSessionChatMemories(sessionId ?? proactiveEngine.getDefaultSessionId())
  )
  ipcMain.handle('memory:clear-all-chat', async () => proactiveEngine.clearAllChatMemories())
  ipcMain.handle('settings:update', async (_event, payload: Partial<SettingsRecord>) =>
    proactiveEngine.updateSettings(payload)
  )
  ipcMain.handle(
    'feedback:submit',
    async (_event, payload: { sessionId: string; messageId: number; feedbackType: FeedbackType; topicType: TopicType | null }) =>
      proactiveEngine.submitFeedback(payload)
  )
  ipcMain.handle('assistant:interrupt', async () => proactiveEngine.interruptSegmentedOutput())
  ipcMain.handle('debug:logs', async () => ({
    logPath: logger.getLogPath(),
    entries: logger.readRecent()
  }))
  ipcMain.handle('debug:storage', async () => ({
    databasePath: repository.getDatabasePath(),
    logPath: logger.getLogPath(),
    memoryFilePath: repository.getMemoryFilePath()
  }))
  ipcMain.handle('qa:auto-run', async () => autoTester.run())
}

app.whenReady().then(async () => {
  logger.init()
  logger.info('app', 'Application starting.')
  await repository.init()
  if (process.env.AUTO_QA_ON_START === '1') {
    try {
      const report = await autoTester.run()
      console.log(`AUTO_QA_REPORT=${JSON.stringify(report)}`)
      logger.info('app', 'AUTO_QA_ON_START finished.', {
        score: report.score,
        summary: report.summary
      })
    } catch (error) {
      console.error(
        `AUTO_QA_REPORT=${JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        })}`
      )
      logger.error('app', 'AUTO_QA_ON_START failed.', {
        error: error instanceof Error ? error : String(error)
      })
      process.exitCode = 1
    } finally {
      app.quit()
    }
    return
  }

  registerIpc()
  await createWindow()
  await proactiveEngine.startScheduler()
  logger.info('app', 'Application ready.')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
