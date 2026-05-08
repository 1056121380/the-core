import { describe, it, expect } from 'vitest'
import { selectTopic } from './topicSelector'
import type { ProactiveContext } from '@main/types/runtime'
import type { MemoryRecord, MessageRecord, RuntimeState, SettingsRecord, TopicType } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'

function makeRuntimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    currentTime: new Date().toISOString(),
    environment: {
      timezone: 'Asia/Hong_Kong',
      locationLabel: 'Hong Kong',
      weatherSummary: '',
      localHour: 10,
      dayPart: 'morning',
      isQuietHours: false
    },
    lastInteractionAt: null,
    lastProactiveAt: null,
    todayProactiveCount: 0,
    cooldownUntil: null,
    recentlyRejected: false,
    userState: 'active',
    lastRejectedAt: null,
    lastTopicType: null,
    activeHourHistogram: Array.from({ length: 24 }, () => 0),
    preferredHourHistogram: Array.from({ length: 24 }, () => 0),
    preferredSegmentCount: null,
    preferredContentLength: null,
    emotionState: 'steady',
    emotionIntensity: 48,
    motivationScore: 50,
    intimacyScore: 35,
    interactionCount: 0,
    conversationalEnergy: 70,
    topicInterest: 0.5,
    desireToTalk: 50,
    estrangementLevel: 0,
    ...overrides
  }
}

function makeContext(overrides: Partial<ProactiveContext> = {}): ProactiveContext {
  return {
    settings: { ...DEFAULT_SETTINGS } as SettingsRecord,
    runtimeState: makeRuntimeState(),
    recentMessages: [],
    memories: [],
    ...overrides
  }
}

const defaultWeights: Record<TopicType, number> = {
  greeting: 1,
  project_reminder: 1,
  task_push: 1,
  simple_review: 1,
  casual_chat: 1
}

describe('selectTopic', () => {
  it('returns greeting when the user just returned', async () => {
    const result = await selectTopic(
      makeContext({ runtimeState: makeRuntimeState({ userState: 'returned' }) }),
      defaultWeights
    )
    expect(result.topicType).toBe('greeting')
  })

  it('returns project_reminder when last topic was greeting', async () => {
    const result = await selectTopic(
      makeContext({ runtimeState: makeRuntimeState({ userState: 'returned', lastTopicType: 'greeting' }) }),
      defaultWeights
    )
    expect(result.topicType).toBe('project_reminder')
  })

  it('returns simple_review for architecture-heavy recent messages', async () => {
    const messages: MessageRecord[] = [
      {
        id: 1,
        sessionId: 'test',
        role: 'user',
        content: '我们来讨论一下系统设计和架构',
        segments: ['我们来讨论一下系统设计和架构'],
        topicType: null,
        isProactive: false,
        createdAt: new Date().toISOString()
      }
    ]
    const result = await selectTopic(makeContext({ recentMessages: messages }), defaultWeights)
    expect(result.topicType).toBe('simple_review')
  })

  it('avoids repeating the last topic when possible', async () => {
    const result = await selectTopic(
      makeContext({ runtimeState: makeRuntimeState({ lastTopicType: 'greeting' }) }),
      defaultWeights
    )
    expect(result.topicType).not.toBe('greeting')
  })

  it('prefers higher weighted topics', async () => {
    const weights: Record<TopicType, number> = {
      greeting: 1,
      project_reminder: 0.5,
      task_push: 2,
      simple_review: 1,
      casual_chat: 1
    }
    const result = await selectTopic(
      makeContext({ runtimeState: makeRuntimeState({ lastTopicType: 'greeting' }) }),
      weights
    )
    expect(result.topicType).toBe('task_push')
  })

  it('always returns a reason string', async () => {
    const result = await selectTopic(makeContext(), defaultWeights)
    expect(result.reason).toBeTruthy()
    expect(typeof result.reason).toBe('string')
  })

  it('selects a project-related topic when project memories exist', async () => {
    const memories: MemoryRecord[] = [
      {
        id: 1,
        type: 'project_fact',
        content: '当前项目是一个 MVP',
        weight: 0.9,
        isPinned: false,
        sessionId: null,
        source: 'manual',
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
    const result = await selectTopic(
      makeContext({
        memories,
        runtimeState: makeRuntimeState({ lastTopicType: 'greeting' })
      }),
      defaultWeights
    )
    expect(['project_reminder', 'task_push']).toContain(result.topicType)
  })

  it('avoids task_push at late_night when soon task exists', async () => {
    const now = Date.now()
    const memories: MemoryRecord[] = [
      {
        id: 1,
        type: 'task',
        content: '完成评分模块',
        weight: 0.9,
        isPinned: false,
        sessionId: null,
        source: 'manual',
        metadata: { taskStatus: 'open', deadline: new Date(now + 12 * 60 * 60 * 1000).toISOString() },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
    const result = await selectTopic(
      makeContext({
        memories,
        runtimeState: makeRuntimeState({
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '',
            localHour: 3,
            dayPart: 'late_night',
            isQuietHours: true
          }
        })
      }),
      defaultWeights
    )
    expect(result.topicType).not.toBe('task_push')
    expect(result.topicType).toBe('simple_review')
  })

  it('avoids task_push at late_night for open tasks without deadline', async () => {
    const memories: MemoryRecord[] = [
      {
        id: 1,
        type: 'task',
        content: '完成评分模块',
        weight: 0.9,
        isPinned: false,
        sessionId: null,
        source: 'manual',
        metadata: { taskStatus: 'open' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
    const result = await selectTopic(
      makeContext({
        memories,
        runtimeState: makeRuntimeState({
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '',
            localHour: 2,
            dayPart: 'late_night',
            isQuietHours: true
          }
        })
      }),
      defaultWeights
    )
    expect(result.topicType).toBe('project_reminder')
  })

  it('selects project_reminder when motivation is high', async () => {
    const result = await selectTopic(
      makeContext({
        runtimeState: makeRuntimeState({
          motivationScore: 75,
          lastTopicType: 'greeting'
        })
      }),
      defaultWeights
    )
    expect(result.topicType).toBe('project_reminder')
  })

  it('selects simple_review in evening when intimacy is high', async () => {
    const result = await selectTopic(
      makeContext({
        settings: { ...DEFAULT_SETTINGS, enableEnvironmentAwareness: true } as SettingsRecord,
        runtimeState: makeRuntimeState({
          intimacyScore: 60,
          lastTopicType: 'greeting',
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '',
            localHour: 20,
            dayPart: 'evening',
            isQuietHours: false
          }
        })
      }),
      defaultWeights
    )
    expect(result.topicType).toBe('simple_review')
  })

  it('does not select simple_review in evening when intimacy is low', async () => {
    const result = await selectTopic(
      makeContext({
        settings: { ...DEFAULT_SETTINGS, enableEnvironmentAwareness: true } as SettingsRecord,
        runtimeState: makeRuntimeState({
          intimacyScore: 30,
          lastTopicType: 'greeting',
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '',
            localHour: 20,
            dayPart: 'evening',
            isQuietHours: false
          }
        })
      }),
      defaultWeights
    )
    expect(result.topicType).not.toBe('simple_review')
  })
})
