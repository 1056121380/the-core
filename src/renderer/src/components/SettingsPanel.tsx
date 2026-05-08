import { DEFAULT_SETTINGS } from '@shared/constants'
import type { SettingsRecord } from '@shared/types'

interface SettingsPanelProps {
  draft: SettingsRecord
  onDraftChange: (draft: SettingsRecord) => void
  onSave: (draft: SettingsRecord) => void
}

type PresetId = 'conservative' | 'default' | 'high_frequency_test'

const TEST_PRESETS: Record<PresetId, { label: string; description: string; patch: Partial<SettingsRecord> }> = {
  conservative: {
    label: '保守低打扰',
    description: '适合日常使用。更高阈值、更长间隔、更低随机主动。',
    patch: {
      threshold: 78,
      dailyLimit: 2,
      cooldownHoursAfterReject: 8,
      checkIntervalMinutes: 10,
      minMinutesBetweenProactive: 120,
      activeConversationBlockMinutes: 5,
      proactiveRandomness: 0.15,
      proactiveDesireBias: -8,
      enableEnvironmentAwareness: true
    }
  },
  default: {
    label: '恢复默认',
    description: '恢复 MVP 默认主动策略和记忆阈值。',
    patch: {
      threshold: DEFAULT_SETTINGS.threshold,
      dailyLimit: DEFAULT_SETTINGS.dailyLimit,
      cooldownHoursAfterReject: DEFAULT_SETTINGS.cooldownHoursAfterReject,
      checkIntervalMinutes: DEFAULT_SETTINGS.checkIntervalMinutes,
      minMinutesBetweenProactive: DEFAULT_SETTINGS.minMinutesBetweenProactive,
      activeConversationBlockMinutes: DEFAULT_SETTINGS.activeConversationBlockMinutes,
      proactiveRandomness: DEFAULT_SETTINGS.proactiveRandomness,
      proactiveDesireBias: DEFAULT_SETTINGS.proactiveDesireBias,
      memoryAutoStoreEnabled: DEFAULT_SETTINGS.memoryAutoStoreEnabled,
      memoryImportanceThreshold: DEFAULT_SETTINGS.memoryImportanceThreshold,
      enableEnvironmentAwareness: DEFAULT_SETTINGS.enableEnvironmentAwareness
    }
  },
  high_frequency_test: {
    label: '高频测试',
    description: '适合调试主动聊天。每 15 秒检查一次，不限制两次主动间隔。',
    patch: {
      threshold: 35,
      dailyLimit: 50,
      cooldownHoursAfterReject: 0.05,
      checkIntervalMinutes: 0.25,
      minMinutesBetweenProactive: 0,
      activeConversationBlockMinutes: 0,
      proactiveRandomness: 1,
      proactiveDesireBias: 20,
      enableEnvironmentAwareness: false
    }
  }
}

export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const update = <K extends keyof SettingsRecord>(key: K, value: SettingsRecord[K]) => {
    props.onDraftChange({ ...props.draft, [key]: value })
  }

  const applyPreset = (presetId: PresetId, shouldSave: boolean): void => {
    const nextDraft = { ...props.draft, ...TEST_PRESETS[presetId].patch }
    props.onDraftChange(nextDraft)
    if (shouldSave) props.onSave(nextDraft)
  }

  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <h2>设置面板</h2>
          <p>修改策略参数、模型连接、环境上下文、人设和记忆入库策略。</p>
        </div>
        <button className="primary-button" onClick={() => props.onSave(props.draft)}>
          保存设置
        </button>
      </div>

      <div className="preset-grid">
        {(Object.entries(TEST_PRESETS) as Array<[PresetId, (typeof TEST_PRESETS)[PresetId]]>).map(([presetId, preset]) => (
          <div key={presetId} className="preset-card">
            <strong>{preset.label}</strong>
            <p>{preset.description}</p>
            <div className="inline-actions">
              <button onClick={() => applyPreset(presetId, false)}>只套用</button>
              <button className="primary-button" onClick={() => applyPreset(presetId, true)}>
                套用并保存
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="debug-reason">
        主动频率由检查间隔、两次主动最小间隔、阈值、聊天欲望偏置和随机强度共同决定。聊天窗口上方也提供了常用快捷调节。
      </p>
      {!props.draft.llmApiKey.trim() ? (
        <p className="debug-reason warning-text">
          当前没有保存 API Key。Mock 已禁用，未配置真实模型时聊天不会再用固定模板兜底。
        </p>
      ) : null}

      <div className="settings-grid">
        <label>
          <span>触发阈值</span>
          <input type="number" value={props.draft.threshold} onChange={(e) => update('threshold', Number(e.target.value))} />
        </label>
        <label>
          <span>聊天欲望偏置（-30 到 30）</span>
          <input
            type="number"
            min="-30"
            max="30"
            value={props.draft.proactiveDesireBias}
            onChange={(e) => update('proactiveDesireBias', Number(e.target.value))}
          />
        </label>
        <label>
          <span>每日主动上限</span>
          <input type="number" value={props.draft.dailyLimit} onChange={(e) => update('dailyLimit', Number(e.target.value))} />
        </label>
        <label>
          <span>拒绝后冷却小时</span>
          <input
            type="number"
            step="0.05"
            min="0"
            value={props.draft.cooldownHoursAfterReject}
            onChange={(e) => update('cooldownHoursAfterReject', Number(e.target.value))}
          />
        </label>
        <label>
          <span>最大分段数</span>
          <input type="number" min="1" max="6" value={props.draft.maxSegments} onChange={(e) => update('maxSegments', Number(e.target.value))} />
        </label>
        <label>
          <span>检查间隔分钟</span>
          <input
            type="number"
            min="0.1"
            step="0.05"
            value={props.draft.checkIntervalMinutes}
            onChange={(e) => update('checkIntervalMinutes', Number(e.target.value))}
          />
        </label>
        <label>
          <span>两次主动最小间隔分钟</span>
          <input
            type="number"
            min="0"
            step="0.5"
            value={props.draft.minMinutesBetweenProactive}
            onChange={(e) => update('minMinutesBetweenProactive', Number(e.target.value))}
          />
        </label>
        <label>
          <span>对话中拦截分钟</span>
          <input
            type="number"
            min="0"
            step="0.5"
            value={props.draft.activeConversationBlockMinutes}
            onChange={(e) => update('activeConversationBlockMinutes', Number(e.target.value))}
          />
        </label>
        <label>
          <span>随机主动强度</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={props.draft.proactiveRandomness}
            onChange={(e) => update('proactiveRandomness', Number(e.target.value))}
          />
        </label>
        <label className="checkbox-field">
          <span>自动记忆入库</span>
          <input
            type="checkbox"
            checked={props.draft.memoryAutoStoreEnabled}
            onChange={(e) => update('memoryAutoStoreEnabled', e.target.checked)}
          />
        </label>
        <label>
          <span>记忆入库阈值</span>
          <input
            type="number"
            min="0.5"
            max="0.95"
            step="0.01"
            value={props.draft.memoryImportanceThreshold}
            onChange={(e) => update('memoryImportanceThreshold', Number(e.target.value))}
          />
        </label>
        <label>
          <span>安静时段开始</span>
          <input type="number" min="0" max="23" value={props.draft.quietHoursStart} onChange={(e) => update('quietHoursStart', Number(e.target.value))} />
        </label>
        <label>
          <span>安静时段结束</span>
          <input type="number" min="0" max="23" value={props.draft.quietHoursEnd} onChange={(e) => update('quietHoursEnd', Number(e.target.value))} />
        </label>
        <label className="checkbox-field">
          <span>启用自检</span>
          <input
            type="checkbox"
            checked={props.draft.enableLlmSelfCheck}
            onChange={(e) => update('enableLlmSelfCheck', e.target.checked)}
          />
        </label>
        <label className="checkbox-field">
          <span>真实模型必需</span>
          <input type="checkbox" checked={true} disabled readOnly />
        </label>
        <label className="checkbox-field">
          <span>环境感知</span>
          <input
            type="checkbox"
            checked={props.draft.enableEnvironmentAwareness}
            onChange={(e) => update('enableEnvironmentAwareness', e.target.checked)}
          />
        </label>
        <label className="checkbox-field">
          <span>情绪系统</span>
          <input
            type="checkbox"
            checked={props.draft.enableEmotionModel}
            onChange={(e) => update('enableEmotionModel', e.target.checked)}
          />
        </label>
        <label className="checkbox-field">
          <span>动机系统</span>
          <input
            type="checkbox"
            checked={props.draft.enableMotivationModel}
            onChange={(e) => update('enableMotivationModel', e.target.checked)}
          />
        </label>
        <label className="checkbox-field">
          <span>亲密度系统</span>
          <input
            type="checkbox"
            checked={props.draft.enableRelationshipModel}
            onChange={(e) => update('enableRelationshipModel', e.target.checked)}
          />
        </label>
        <label>
          <span>口头禅（逗号分隔）</span>
          <input
            type="text"
            value={props.draft.verbalTics.join('，')}
            onChange={(e) => update('verbalTics', e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean))}
          />
        </label>
        <label>
          <span>模型接口地址</span>
          <input type="text" value={props.draft.llmBaseUrl} onChange={(e) => update('llmBaseUrl', e.target.value)} />
        </label>
        <label>
          <span>模型名称</span>
          <input type="text" value={props.draft.llmModel} onChange={(e) => update('llmModel', e.target.value)} />
        </label>
        <label>
          <span>日志级别</span>
          <select value={props.draft.logLevel} onChange={(e) => update('logLevel', e.target.value as SettingsRecord['logLevel'])}>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>
        <label>
          <span>时区</span>
          <input type="text" value={props.draft.assistantTimezone} onChange={(e) => update('assistantTimezone', e.target.value)} />
        </label>
        <label>
          <span>位置</span>
          <input type="text" value={props.draft.assistantLocation} onChange={(e) => update('assistantLocation', e.target.value)} />
        </label>
        <label className="settings-grid-span-2">
          <span>天气摘要</span>
          <input
            type="text"
            value={props.draft.weatherSummary}
            onChange={(e) => update('weatherSummary', e.target.value)}
            placeholder="例如：下午有雨，用户大概率在室内工作"
          />
        </label>
        <label className="settings-grid-span-2">
          <span>API Key</span>
          <input
            type="password"
            value={props.draft.llmApiKey}
            onChange={(e) => update('llmApiKey', e.target.value)}
            placeholder="填入 API Key，保存后直接生效"
          />
        </label>
        <label className="settings-grid-span-2">
          <span>身份事实</span>
          <textarea
            rows={4}
            value={props.draft.identityProfile}
            onChange={(e) => update('identityProfile', e.target.value)}
            placeholder="例如：你是一个活泼、自然、有一点俏皮感的女生型桌面聊天助手"
          />
        </label>
        <label className="settings-grid-span-2">
          <span>人设提示词</span>
          <textarea
            rows={5}
            value={props.draft.personaPrompt}
            onChange={(e) => update('personaPrompt', e.target.value)}
            placeholder="定义说话语气、边界感和输出风格"
          />
        </label>
        <label className="settings-grid-span-2">
          <span>习惯 / 行为画像</span>
          <textarea
            rows={4}
            value={props.draft.habitProfile}
            onChange={(e) => update('habitProfile', e.target.value)}
            placeholder="例如：上午更活跃，偏好短句，先看主链路，不喜欢被催促"
          />
        </label>
      </div>
    </section>
  )
}
