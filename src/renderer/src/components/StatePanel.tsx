import type { RuntimeState, UserState } from '@shared/types'
import { formatTime } from '@renderer/lib/time'

interface StatePanelProps {
  runtimeState: RuntimeState
  currentTimeLabel: string
  onSetUserState: (state: UserState) => void
  onClearCooldown: () => void
}

const STATES: Array<{ value: UserState; label: string }> = [
  { value: 'active', label: '活跃' },
  { value: 'idle', label: '空闲' },
  { value: 'away', label: '离开' },
  { value: 'returned', label: '返回' },
  { value: 'cooldown', label: '冷却' }
]

export function StatePanel(props: StatePanelProps): JSX.Element {
  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <h2>状态面板</h2>
          <p>手动模拟用户状态，观察环境、情绪、动机和关系值如何影响主动聊天。</p>
        </div>
      </div>
      <div className="kv-grid">
        <div>
          <span>当前时间</span>
          <strong>{props.currentTimeLabel}</strong>
        </div>
        <div>
          <span>当前状态</span>
          <strong>{props.runtimeState.userState}</strong>
        </div>
        <div>
          <span>今日主动次数</span>
          <strong>{props.runtimeState.todayProactiveCount}</strong>
        </div>
        <div>
          <span>冷却到</span>
          <strong>{formatTime(props.runtimeState.cooldownUntil)}</strong>
        </div>
        <div>
          <span>上次主动</span>
          <strong>{formatTime(props.runtimeState.lastProactiveAt)}</strong>
        </div>
        <div>
          <span>最近互动</span>
          <strong>{formatTime(props.runtimeState.lastInteractionAt)}</strong>
        </div>
        <div>
          <span>环境时段</span>
          <strong>{props.runtimeState.environment.dayPart}</strong>
        </div>
        <div>
          <span>环境位置</span>
          <strong>{props.runtimeState.environment.locationLabel || '-'}</strong>
        </div>
        <div>
          <span>天气摘要</span>
          <strong>{props.runtimeState.environment.weatherSummary || '-'}</strong>
        </div>
        <div>
          <span>安静时段</span>
          <strong>{props.runtimeState.environment.isQuietHours ? '是' : '否'}</strong>
        </div>
        <div>
          <span>情绪状态</span>
          <strong>{props.runtimeState.emotionState}</strong>
        </div>
        <div>
          <span>情绪强度</span>
          <strong>{props.runtimeState.emotionIntensity}</strong>
        </div>
        <div>
          <span>动机分</span>
          <strong>{props.runtimeState.motivationScore}</strong>
        </div>
        <div>
          <span>亲密度</span>
          <strong>{props.runtimeState.intimacyScore}</strong>
        </div>
        <div>
          <span>互动次数</span>
          <strong>{props.runtimeState.interactionCount}</strong>
        </div>
        <div>
          <span>生疏感</span>
          <strong>{props.runtimeState.estrangementLevel}</strong>
        </div>
      </div>
      <div className="button-grid">
        {STATES.map((state) => (
          <button
            key={state.value}
            className={props.runtimeState.userState === state.value ? 'selected-feedback' : ''}
            onClick={() => props.onSetUserState(state.value)}
          >
            设为 {state.label}
          </button>
        ))}
      </div>
      <button onClick={props.onClearCooldown}>取消别打扰</button>
    </section>
  )
}
