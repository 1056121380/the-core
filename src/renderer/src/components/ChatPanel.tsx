import type { ChatExportResult, FeedbackRecord, MessageRecord, SettingsRecord, TypingEventPayload } from '@shared/types'
import { formatTime } from '@renderer/lib/time'

interface ChatPanelProps {
  messages: MessageRecord[]
  feedback: FeedbackRecord[]
  input: string
  isChecking: boolean
  settings: SettingsRecord
  typingState: TypingEventPayload['state']
  onInputChange: (value: string) => void
  onSend: () => void
  onClearChat: () => void
  onExportChat: () => void
  onManualCheck: () => void
  onQuickSettingsChange: (patch: Partial<SettingsRecord>) => void
  onFeedback: (message: MessageRecord, type: 'positive' | 'neutral' | 'negative') => void
  isExporting: boolean
  exportResult: ChatExportResult | null
}

interface DisplayBubble {
  key: string
  message: MessageRecord
  content: string
  isLastSegment: boolean
}

function buildDisplayBubbles(messages: MessageRecord[]): DisplayBubble[] {
  return messages.flatMap<DisplayBubble>((message) => {
    const parts = message.segments.length > 0 ? message.segments : [message.content]

    if (message.role !== 'assistant' || parts.length <= 1) {
      return [
        {
          key: `${message.id}-full`,
          message,
          content: parts.join('\n'),
          isLastSegment: true
        }
      ]
    }

    return parts.map((segment, index) => ({
      key: `${message.id}-${index}`,
      message,
      content: segment,
      isLastSegment: index === parts.length - 1
    }))
  })
}

export function ChatPanel(props: ChatPanelProps): JSX.Element {
  const feedbackMap = new Map(props.feedback.map((item) => [item.messageId, item.feedbackType]))
  const bubbles = buildDisplayBubbles(props.messages)

  return (
    <section className="panel chat-panel">
      <div className="panel-header">
        <div>
          <h2>聊天</h2>
          <p>这里是正常聊天窗口。主动频率、聊天欲望和记忆入库可以在下方边聊边调。</p>
        </div>
        <button className="primary-button" onClick={props.onManualCheck} disabled={props.isChecking}>
          {props.isChecking ? '检查中...' : '手动触发主动检查'}
        </button>
        <button onClick={props.onClearChat} disabled={props.messages.length === 0}>
          清空聊天
        </button>
        <button onClick={props.onExportChat} disabled={props.isExporting || props.messages.length === 0}>
          {props.isExporting ? '导出中...' : '导出聊天记录'}
        </button>
      </div>

      <div className="quick-control-grid">
        <label>
          <span>聊天欲望 {props.settings.proactiveDesireBias}</span>
          <input
            type="range"
            min="-30"
            max="30"
            step="1"
            value={props.settings.proactiveDesireBias}
            onChange={(event) => props.onQuickSettingsChange({ proactiveDesireBias: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>主动阈值 {props.settings.threshold}</span>
          <input
            type="range"
            min="20"
            max="95"
            step="1"
            value={props.settings.threshold}
            onChange={(event) => props.onQuickSettingsChange({ threshold: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>主动检查间隔 {props.settings.checkIntervalMinutes} 分钟</span>
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={props.settings.checkIntervalMinutes}
            onChange={(event) => props.onQuickSettingsChange({ checkIntervalMinutes: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>两次主动最小间隔 {props.settings.minMinutesBetweenProactive} 分钟</span>
          <input
            type="number"
            min="0"
            step="1"
            value={props.settings.minMinutesBetweenProactive}
            onChange={(event) => props.onQuickSettingsChange({ minMinutesBetweenProactive: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>自动记忆入库</span>
          <select
            value={props.settings.memoryAutoStoreEnabled ? 'on' : 'off'}
            onChange={(event) => props.onQuickSettingsChange({ memoryAutoStoreEnabled: event.target.value === 'on' })}
          >
            <option value="on">开启：先判断值得记再保存</option>
            <option value="off">关闭：只保留短期摘要和手动记忆</option>
          </select>
        </label>
        <label>
          <span>记忆阈值 {props.settings.memoryImportanceThreshold.toFixed(2)}</span>
          <input
            type="range"
            min="0.5"
            max="0.95"
            step="0.01"
            value={props.settings.memoryImportanceThreshold}
            onChange={(event) => props.onQuickSettingsChange({ memoryImportanceThreshold: Number(event.target.value) })}
          />
        </label>
      </div>

      {props.exportResult ? (
        <div className="export-hint">
          <strong>已导出聊天记录</strong>
          <span>JSON：{props.exportResult.jsonPath}</span>
          <span>Markdown：{props.exportResult.markdownPath}</span>
        </div>
      ) : null}

      <div className="message-list">
        {bubbles.map((bubble) => (
          <article key={bubble.key} className={`message-card role-${bubble.message.role}`}>
            <div className="message-meta">
              <span>{bubble.message.role}</span>
              <span>{formatTime(bubble.message.createdAt)}</span>
              {bubble.message.topicType ? <span>{bubble.message.topicType}</span> : null}
            </div>
            <div className="message-bubble">
              <p>{bubble.content}</p>
            </div>
            {bubble.message.isProactive && bubble.message.role === 'assistant' && bubble.isLastSegment ? (
              <div className="feedback-row">
                {(['positive', 'neutral', 'negative'] as const).map((type) => (
                  <button
                    key={type}
                    className={feedbackMap.get(bubble.message.id) === type ? 'selected-feedback' : ''}
                    disabled={Boolean(feedbackMap.get(bubble.message.id))}
                    onClick={() => props.onFeedback(bubble.message, type)}
                  >
                    {type === 'positive' ? '有用' : type === 'neutral' ? '一般' : '别打扰'}
                  </button>
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {props.typingState !== 'idle' ? (
          <div className="typing-indicator">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-label">
              {props.typingState === 'reading' ? '已读' : '正在输入'}
            </span>
          </div>
        ) : null}
      </div>

      <div className="composer">
        <textarea
          value={props.input}
          rows={3}
          placeholder="输入消息。回车发送，Shift + Enter 换行。"
          onChange={(event) => props.onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              props.onSend()
            }
          }}
        />
        <button className="primary-button" onClick={props.onSend} disabled={!props.input.trim()}>
          发送
        </button>
      </div>
    </section>
  )
}
