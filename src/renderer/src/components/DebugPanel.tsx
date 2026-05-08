import type {
  DebugLogEntry,
  FeedbackRecord,
  MemoryDebugState,
  ProactiveEventRecord,
  ScoreBreakdownItem
} from '@shared/types'
import { formatTime } from '@renderer/lib/time'

interface DebugPanelProps {
  latestEvent: ProactiveEventRecord | null
  feedback: FeedbackRecord[]
  debugLogs: DebugLogEntry[]
  logPath: string
  databasePath: string
  memoryFilePath: string
  memoryDebug: MemoryDebugState
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function explainBreakdown(items: ScoreBreakdownItem[]): string {
  if (items.length === 0) {
    return '这次没有进入评分阶段，通常是被硬规则拦截了。'
  }

  const positive = [...items].filter((item) => item.value > 0).sort((a, b) => b.value - a.value).slice(0, 3)
  const negative = [...items].filter((item) => item.value < 0).sort((a, b) => a.value - b.value).slice(0, 2)
  const positiveText = positive.length > 0 ? positive.map((item) => `${item.name} +${item.value}`).join('，') : '没有明显加分项'
  const negativeText = negative.length > 0 ? negative.map((item) => `${item.name} ${item.value}`).join('，') : '没有明显扣分项'
  return `主要加分：${positiveText}。主要扣分：${negativeText}。`
}

export function DebugPanel(props: DebugPanelProps): JSX.Element {
  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <h2>调试面板</h2>
          <p>显示最近一次主动决策、记忆命中、反馈记录、存储路径和主进程日志。</p>
        </div>
      </div>

      {props.latestEvent ? (
        <div className="debug-block">
          <div className="kv-grid">
            <div>
              <span>决策</span>
              <strong>{props.latestEvent.decision}</strong>
            </div>
            <div>
              <span>分数</span>
              <strong>{props.latestEvent.score ?? '-'}</strong>
            </div>
            <div>
              <span>事件类型</span>
              <strong>{props.latestEvent.eventType}</strong>
            </div>
            <div>
              <span>记录时间</span>
              <strong>{formatTime(props.latestEvent.createdAt)}</strong>
            </div>
          </div>
          <p className="debug-reason">{props.latestEvent.reason}</p>
          <p className="debug-reason">{explainBreakdown(props.latestEvent.breakdown)}</p>
          <div className="breakdown-list">
            {props.latestEvent.breakdown.map((item) => (
              <div key={`${item.name}-${item.value}`} className="breakdown-item">
                <span>{item.name}</span>
                <strong>{item.value > 0 ? `+${item.value}` : item.value}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p>还没有主动决策记录。</p>
      )}

      <div className="feedback-log">
        <h3>记忆调试</h3>
        <div className="kv-grid">
          <div>
            <span>摘要模式</span>
            <strong>{props.memoryDebug.latestSummaryMode}</strong>
          </div>
          <div>
            <span>摘要更新时间</span>
            <strong>{formatTime(props.memoryDebug.latestSummaryAt)}</strong>
          </div>
          <div>
            <span>最近命中阶段</span>
            <strong>{props.memoryDebug.latestSelectionStage ?? '-'}</strong>
          </div>
          <div>
            <span>命中时间</span>
            <strong>{formatTime(props.memoryDebug.latestSelectionAt)}</strong>
          </div>
        </div>
        <p className="debug-reason">最近摘要：{props.memoryDebug.latestSummaryContent || '暂无'}</p>
        <p className="debug-reason">最近检索查询：{props.memoryDebug.latestSelectionQuery || '暂无'}</p>
        {props.memoryDebug.selectedMemories.length > 0 ? (
          <div className="breakdown-list">
            {props.memoryDebug.selectedMemories.map((item) => (
              <div key={`${item.memoryId}-${item.score}`} className="memory-debug-card">
                <div className="memory-debug-header">
                  <strong>{item.type}</strong>
                  <span>{item.layer}</span>
                  <span>{item.sessionId ? '当前会话' : '全局'}</span>
                  <span>{item.source}</span>
                  <span>{item.isPinned ? '已锁定' : '可衰减'}</span>
                </div>
                <p>{item.content}</p>
                <div className="memory-metric-row">
                  <span>权重 {item.weight.toFixed(2)}</span>
                  <span>命中分 {item.score.toFixed(1)}</span>
                  <span>命中次数 {item.hitCount ?? 0}</span>
                </div>
                <div className="memory-metric-row">
                  <span>可信度 {item.confidence == null ? '-' : item.confidence.toFixed(2)}</span>
                  <span>上次命中 {formatTime(item.lastHitAt ?? null)}</span>
                </div>
                <div className="memory-bar-group">
                  <div>
                    <span>权重</span>
                    <div className="memory-bar-track">
                      <div className="memory-bar-fill weight-fill" style={{ width: formatPercent(item.weight) }} />
                    </div>
                  </div>
                  <div>
                    <span>命中分</span>
                    <div className="memory-bar-track">
                      <div className="memory-bar-fill score-fill" style={{ width: `${Math.min(100, item.score)}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p>最近还没有命中记忆。</p>
        )}
      </div>

      <div className="feedback-log">
        <h3>最近反馈</h3>
        {props.feedback.length > 0 ? (
          props.feedback.map((item) => (
            <div key={item.id} className="feedback-log-item">
              <span>{item.feedbackType}</span>
              <span>{item.topicType ?? '-'}</span>
              <span>{formatTime(item.createdAt)}</span>
            </div>
          ))
        ) : (
          <p>还没有反馈记录。</p>
        )}
      </div>

      <div className="feedback-log">
        <h3>存储位置</h3>
        <p className="debug-reason">数据库：{props.databasePath || '暂不可用'}</p>
        <p className="debug-reason">记忆文件：{props.memoryFilePath || '暂不可用'}</p>
        <p className="debug-reason">日志：{props.logPath || '暂不可用'}</p>
      </div>

      <div className="feedback-log">
        <h3>最近日志</h3>
        {props.debugLogs.length > 0 ? (
          props.debugLogs.map((item, index) => (
            <div key={`${item.timestamp}-${index}`} className="feedback-log-item">
              <span>{formatTime(item.timestamp)}</span>
              <span>{item.level}</span>
              <span>{item.scope}</span>
              <span>{item.message}</span>
            </div>
          ))
        ) : (
          <p>还没有日志。</p>
        )}
      </div>
    </section>
  )
}
