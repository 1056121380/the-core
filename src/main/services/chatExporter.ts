import fs from 'node:fs'
import path from 'node:path'
import type {
  ChatExportResult,
  FeedbackRecord,
  MemoryRecord,
  MessageRecord,
  ProactiveEventRecord,
  RuntimeState,
  SettingsRecord
} from '@shared/types'
import { AppRepository } from '@main/repositories/database'
import { logger } from '@main/services/logger'

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'session'
}

function redactSettings(settings: SettingsRecord): SettingsRecord {
  return {
    ...settings,
    llmApiKey: settings.llmApiKey ? '[redacted]' : ''
  }
}

function formatJson(input: unknown): string {
  return JSON.stringify(input, null, 2)
}

function formatMessage(message: MessageRecord, feedback: FeedbackRecord | undefined): string {
  const flags = [
    `id=${message.id}`,
    `role=${message.role}`,
    message.isProactive ? 'proactive=true' : null,
    message.topicType ? `topic=${message.topicType}` : null,
    feedback ? `feedback=${feedback.feedbackType}` : null
  ].filter(Boolean)
  const body = message.segments.length > 0 ? message.segments.map((segment) => `- ${segment}`).join('\n') : message.content
  return `### ${message.createdAt} (${flags.join(', ')})\n\n${body}`
}

function formatEvent(event: ProactiveEventRecord): string {
  const breakdown = event.breakdown.length > 0
    ? event.breakdown.map((item) => `${item.name}:${item.value}`).join(', ')
    : '无'
  return `- ${event.createdAt} | ${event.decision} | score=${event.score ?? 'null'} | ${event.reason} | ${breakdown}`
}

function formatMemory(memory: MemoryRecord): string {
  const scope = memory.sessionId ? `session:${memory.sessionId}` : 'global'
  return `- #${memory.id} ${memory.type} ${scope} weight=${memory.weight.toFixed(2)} pinned=${memory.isPinned} source=${memory.source}: ${memory.content}`
}

function buildMarkdown(input: {
  sessionId: string
  exportedAt: string
  messages: MessageRecord[]
  feedback: FeedbackRecord[]
  proactiveEvents: ProactiveEventRecord[]
  memories: MemoryRecord[]
  runtimeState: RuntimeState
  settings: SettingsRecord
}): string {
  const feedbackByMessageId = new Map(input.feedback.map((item) => [item.messageId, item]))
  return [
    `# 聊天记录导出`,
    '',
    `- session_id: ${input.sessionId}`,
    `- exported_at: ${input.exportedAt}`,
    `- message_count: ${input.messages.length}`,
    `- proactive_event_count: ${input.proactiveEvents.length}`,
    `- mock_mode: ${input.settings.mockMode}`,
    `- llm_enabled: ${input.settings.llmEnabled}`,
    `- llm_model: ${input.settings.llmModel || '未设置'}`,
    '',
    '## 当前运行状态',
    '',
    `- user_state: ${input.runtimeState.userState}`,
    `- emotion: ${input.runtimeState.emotionState} (${input.runtimeState.emotionIntensity})`,
    `- motivation_score: ${input.runtimeState.motivationScore}`,
    `- intimacy_score: ${input.runtimeState.intimacyScore}`,
    `- cooldown_until: ${input.runtimeState.cooldownUntil ?? '无'}`,
    `- last_interaction_at: ${input.runtimeState.lastInteractionAt ?? '无'}`,
    `- last_proactive_at: ${input.runtimeState.lastProactiveAt ?? '无'}`,
    '',
    '## 聊天消息',
    '',
    input.messages.length > 0
      ? input.messages.map((message) => formatMessage(message, feedbackByMessageId.get(message.id))).join('\n\n')
      : '无聊天消息。',
    '',
    '## 主动决策记录',
    '',
    input.proactiveEvents.length > 0 ? input.proactiveEvents.map(formatEvent).join('\n') : '无主动决策记录。',
    '',
    '## 相关记忆',
    '',
    input.memories.length > 0 ? input.memories.map(formatMemory).join('\n') : '无记忆。',
    ''
  ].join('\n')
}

export class ChatExporter {
  constructor(private readonly repository: AppRepository) {}

  async exportSession(sessionId: string): Promise<ChatExportResult> {
    const exportedAt = new Date().toISOString()
    const exportDir = path.join(path.dirname(this.repository.getDatabasePath()), 'exports')
    fs.mkdirSync(exportDir, { recursive: true })

    const [messages, feedback, proactiveEvents, memories, runtimeState, settings] = await Promise.all([
      this.repository.listAllMessages(sessionId),
      this.repository.listAllFeedback(sessionId),
      this.repository.listProactiveEvents(sessionId),
      this.repository.listMemories({ sessionId, includeGlobal: true }),
      this.repository.getRuntimeState(sessionId),
      this.repository.getSettings()
    ])

    const safeSessionId = safeFilePart(sessionId)
    const stamp = exportedAt.replace(/[:.]/g, '-')
    const jsonPath = path.join(exportDir, `${safeSessionId}_${stamp}.json`)
    const markdownPath = path.join(exportDir, `${safeSessionId}_${stamp}.md`)
    const payload = {
      exportedAt,
      sessionId,
      messages,
      feedback,
      proactiveEvents,
      memories,
      runtimeState,
      settings: redactSettings(settings)
    }

    fs.writeFileSync(jsonPath, formatJson(payload), 'utf8')
    fs.writeFileSync(markdownPath, buildMarkdown({ ...payload, settings: redactSettings(settings) }), 'utf8')
    logger.info('chat-export', 'Chat session exported.', {
      sessionId,
      jsonPath,
      markdownPath,
      messageCount: messages.length,
      proactiveEventCount: proactiveEvents.length
    })

    return {
      sessionId,
      exportedAt,
      jsonPath,
      markdownPath,
      messageCount: messages.length,
      proactiveEventCount: proactiveEvents.length
    }
  }
}
