import { useMemo, useState } from 'react'
import { getMemoryLayer } from '@shared/constants'
import type { MemoryRecord, MemoryType } from '@shared/types'
import { formatTime } from '@renderer/lib/time'

interface MemoryPanelProps {
  memories: MemoryRecord[]
  memoryFilePath: string
  onAddMemory: (payload: {
    type: MemoryType
    content: string
    weight: number
    isPinned?: boolean
    sessionId?: string | null
    metadata?: MemoryRecord['metadata']
  }) => void
  onDeleteMemory: (id: number) => void
  onSetMemoryPinned: (id: number, isPinned: boolean) => void
  onClearSessionChatMemories: () => void
  onClearAllChatMemories: () => void
}

const TYPE_LABELS: Record<MemoryType, string> = {
  recent_summary: '近期摘要',
  proactive_summary: '上次主动摘要',
  project_fact: '项目事实',
  project_goal: '项目目标',
  user_fact: '用户事实',
  user_preference: '用户偏好',
  style_rule: '风格规则',
  task: '任务'
}

const EDITABLE_TYPES: MemoryType[] = [
  'project_fact',
  'project_goal',
  'user_fact',
  'user_preference',
  'style_rule',
  'task'
]

export function MemoryPanel(props: MemoryPanelProps): JSX.Element {
  const [type, setType] = useState<MemoryType>('project_fact')
  const [scope, setScope] = useState<'global' | 'session'>('global')
  const [content, setContent] = useState('')
  const [weight, setWeight] = useState('0.8')
  const [isPinned, setIsPinned] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | MemoryType>('all')

  const filteredMemories = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return props.memories.filter((memory) => {
      if (typeFilter !== 'all' && memory.type !== typeFilter) return false
      if (!keyword) return true

      const haystack = [
        memory.content,
        memory.type,
        TYPE_LABELS[memory.type],
        getMemoryLayer(memory.type),
        memory.source,
        memory.sessionId ? '当前会话' : '全局',
        memory.metadata?.deadline ?? '',
        memory.metadata?.taskStatus ?? ''
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(keyword)
    })
  }, [props.memories, query, typeFilter])

  const groupedCount = useMemo(() => {
    return props.memories.reduce<Record<MemoryType, number>>(
      (acc, memory) => {
        acc[memory.type] += 1
        return acc
      },
      {
        recent_summary: 0,
        proactive_summary: 0,
        project_fact: 0,
        project_goal: 0,
        user_fact: 0,
        user_preference: 0,
        style_rule: 0,
        task: 0
      }
    )
  }, [props.memories])

  return (
    <section className="panel">
      <div className="panel-header compact">
        <div>
          <h2>记忆面板</h2>
          <p>记忆已按类型和层级管理。手动添加的事实/偏好不会被自动清理，聊天自动沉淀会先判断重要性。</p>
          <p className="panel-path">记忆文件：{props.memoryFilePath || '暂不可用'}</p>
        </div>
      </div>

      <div className="memory-type-grid">
        {(['all', ...EDITABLE_TYPES, 'recent_summary', 'proactive_summary'] as Array<'all' | MemoryType>).map((item) => (
          <button
            key={item}
            className={typeFilter === item ? 'selected-feedback' : ''}
            onClick={() => setTypeFilter(item)}
          >
            {item === 'all' ? `全部 ${props.memories.length}` : `${TYPE_LABELS[item]} ${groupedCount[item]}`}
          </button>
        ))}
      </div>

      <div className="stack-form">
        <input
          type="text"
          value={query}
          placeholder="搜索记忆内容、类型、层级、来源或 deadline"
          onChange={(event) => setQuery(event.target.value)}
        />

        <select value={type} onChange={(event) => setType(event.target.value as MemoryType)}>
          {EDITABLE_TYPES.map((value) => (
            <option key={value} value={value}>
              {TYPE_LABELS[value]}
            </option>
          ))}
        </select>

        <select value={scope} onChange={(event) => setScope(event.target.value as 'global' | 'session')}>
          <option value="global">全局记忆</option>
          <option value="session">当前会话记忆</option>
        </select>

        <textarea
          value={content}
          rows={3}
          placeholder="输入记忆内容。比如：用户偏好更活泼一点的语气。"
          onChange={(event) => setContent(event.target.value)}
        />

        {type === 'task' ? (
          <input
            type="datetime-local"
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
          />
        ) : null}

        <input
          value={weight}
          type="number"
          min="0"
          max="1"
          step="0.05"
          onChange={(event) => setWeight(event.target.value)}
        />

        <label className="checkbox-field">
          <span>锁定这条记忆</span>
          <input type="checkbox" checked={isPinned} onChange={(event) => setIsPinned(event.target.checked)} />
        </label>

        <button
          className="primary-button"
          onClick={() => {
            if (!content.trim()) return
            props.onAddMemory({
              type,
              content: content.trim(),
              weight: Number(weight) || 0.5,
              isPinned,
              sessionId: scope === 'session' ? 'desktop_default' : null,
              metadata:
                type === 'task'
                  ? {
                      deadline: deadline ? new Date(deadline).toISOString() : null,
                      taskStatus: 'open'
                    }
                  : null
            })
            setContent('')
            setWeight('0.8')
            setIsPinned(false)
            setDeadline('')
          }}
        >
          新增记忆
        </button>

        <div className="feedback-row">
          <button onClick={props.onClearSessionChatMemories}>清空当前会话聊天记忆</button>
          <button onClick={props.onClearAllChatMemories}>清空全部聊天记忆</button>
        </div>
      </div>

      <div className="list-summary">
        <span>当前显示 {filteredMemories.length} 条记忆</span>
        <span>总计 {props.memories.length} 条</span>
      </div>

      <div className="scroll-list">
        {filteredMemories.map((memory) => (
          <article key={memory.id} className="list-card">
            <div className="list-card-header">
              <strong>{TYPE_LABELS[memory.type]}</strong>
              <div className="inline-actions">
                <button onClick={() => props.onSetMemoryPinned(memory.id, !memory.isPinned)}>
                  {memory.isPinned ? '取消锁定' : '锁定'}
                </button>
                <button onClick={() => props.onDeleteMemory(memory.id)}>删除</button>
              </div>
            </div>
            <p>{memory.content}</p>
            <div className="list-card-meta">
              <span>层级: {getMemoryLayer(memory.type)}</span>
              <span>权重: {memory.weight.toFixed(2)}</span>
              <span>{memory.sessionId ? '当前会话' : '全局'}</span>
              <span>{memory.source}</span>
              <span>{memory.isPinned ? '已锁定' : '可衰减'}</span>
              {memory.metadata?.deadline ? <span>截止: {formatTime(memory.metadata.deadline)}</span> : null}
              {memory.metadata?.taskStatus ? <span>状态: {memory.metadata.taskStatus}</span> : null}
              {memory.metadata?.importanceReason ? <span>原因: {memory.metadata.importanceReason}</span> : null}
              <span>{formatTime(memory.updatedAt)}</span>
            </div>
          </article>
        ))}
        {filteredMemories.length === 0 ? <p>没有匹配的记忆。</p> : null}
      </div>
    </section>
  )
}
