import type { AutoTestReport } from '@shared/types'
import { formatTime } from '@renderer/lib/time'

interface AutoTestPanelProps {
  report: AutoTestReport | null
  isRunning: boolean
  onRun: () => void
}

export function AutoTestPanel(props: AutoTestPanelProps): JSX.Element {
  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <h2>AI 多角度聊天测试</h2>
          <p>自动覆盖普通对话、上下文追问、风格漂移、内部上下文泄漏、分段质量、重复消息、主动触发、冷却和记忆沉淀。</p>
        </div>
        <button className="primary-button" onClick={props.onRun} disabled={props.isRunning}>
          {props.isRunning ? '测试运行中...' : '运行多角度测试'}
        </button>
      </div>

      {props.report ? (
        <div className="debug-block">
          <div className="kv-grid">
            <div>
              <span>总分</span>
              <strong>{props.report.score}</strong>
            </div>
            <div>
              <span>是否用真实模型</span>
              <strong>{props.report.usedLiveLlm ? '是' : '否'}</strong>
            </div>
            <div>
              <span>开始时间</span>
              <strong>{formatTime(props.report.startedAt)}</strong>
            </div>
            <div>
              <span>结束时间</span>
              <strong>{formatTime(props.report.finishedAt)}</strong>
            </div>
          </div>
          <p className="debug-reason">{props.report.summary}</p>
          {!props.report.usedLiveLlm ? (
            <p className="debug-reason warning-text">
              当前没有可用真实模型，测试不会用固定模板兜底。请先在设置里填入可用 API Key、Base URL 和模型名。
            </p>
          ) : null}

          <div className="feedback-log">
            <h3>分项结果</h3>
            {props.report.cases.map((item) => (
              <div key={item.id} className="list-card">
                <div className="list-card-header">
                  <strong>{item.name}</strong>
                  <span>{item.status}</span>
                </div>
                <p>{item.summary}</p>
                <div className="breakdown-list">
                  {item.details.map((detail, index) => (
                    <div key={`${item.id}-${index}`} className="breakdown-item">
                      <span>{detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="feedback-log">
            <h3>建议</h3>
            {props.report.recommendations.map((item, index) => (
              <div key={`${item}-${index}`} className="breakdown-item">
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p>还没有自动测试报告。</p>
      )}
    </section>
  )
}
