import { describe, it, expect } from 'vitest'
import { calculateProactiveScore } from './scoring'
import type { ProactiveContext } from '@main/types/runtime'
import type { MemoryRecord, RuntimeState, SettingsRecord } from '@shared/types'
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

describe('calculateProactiveScore', () => {
  it('returns score between 0 and 100', () => {
    const result = calculateProactiveScore(makeContext())
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
  })

  it('includes time_recovery in breakdown', () => {
    const result = calculateProactiveScore(makeContext())
    expect(result.breakdown.find((item) => item.name === 'time_recovery')).toBeDefined()
  })

  it('gives idle_bonus when user is idle', () => {
    const result = calculateProactiveScore(makeContext({ runtimeState: makeRuntimeState({ userState: 'idle' }) }))
    expect(result.breakdown.find((item) => item.name === 'idle_bonus')?.value).toBe(15)
  })

  it('gives returned_bonus when user returned', () => {
    const result = calculateProactiveScore(
      makeContext({ runtimeState: makeRuntimeState({ userState: 'returned' }) })
    )
    expect(result.breakdown.find((item) => item.name === 'returned_bonus')?.value).toBe(25)
  })

  it('applies rejection_penalty when recently rejected', () => {
    const result = calculateProactiveScore(
      makeContext({ runtimeState: makeRuntimeState({ recentlyRejected: true }) })
    )
    expect(result.breakdown.find((item) => item.name === 'rejection_penalty')?.value).toBe(-40)
  })

  it('applies daily_count_penalty for 1 proactive today', () => {
    const result = calculateProactiveScore(
      makeContext({ runtimeState: makeRuntimeState({ todayProactiveCount: 1 }) })
    )
    expect(result.breakdown.find((item) => item.name === 'daily_count_penalty')?.value).toBe(-10)
  })

  it('applies stronger daily_count_penalty for 2+ proactive today', () => {
    const result = calculateProactiveScore(
      makeContext({ runtimeState: makeRuntimeState({ todayProactiveCount: 3 }) })
    )
    expect(result.breakdown.find((item) => item.name === 'daily_count_penalty')?.value).toBe(-25)
  })

  it('gives higher time_recovery when more time has passed since last proactive', () => {
    const recent = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({
          lastProactiveAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
        })
      })
    )
    const older = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({
          lastProactiveAt: new Date(Date.now() - 180 * 60 * 1000).toISOString()
        })
      })
    )
    const recentTime = recent.breakdown.find((item) => item.name === 'time_recovery')
    const oldTime = older.breakdown.find((item) => item.name === 'time_recovery')
    expect(oldTime!.value).toBeGreaterThanOrEqual(recentTime!.value)
  })

  it('gives project_memory_bonus for project memories', () => {
    const memories: MemoryRecord[] = [
      {
        id: 1,
        type: 'project_fact',
        content: 'test',
        weight: 0.8,
        isPinned: false,
        sessionId: null,
        source: 'manual',
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
    const result = calculateProactiveScore(makeContext({ memories }))
    const bonus = result.breakdown.find((item) => item.name === 'project_memory_bonus')
    expect(bonus).toBeDefined()
    expect(bonus!.value).toBeGreaterThan(0)
  })

  it('includes random_jitter in breakdown', () => {
    const result = calculateProactiveScore(makeContext())
    const jitter = result.breakdown.find((item) => item.name === 'random_jitter')
    expect(jitter).toBeDefined()
    expect(jitter!.value).toBeGreaterThanOrEqual(-4)
    expect(jitter!.value).toBeLessThanOrEqual(4)
  })

  it('gives motivation_signal when motivationScore is above 50', () => {
    const result = calculateProactiveScore(
      makeContext({ runtimeState: makeRuntimeState({ motivationScore: 76 }) })
    )
    const signal = result.breakdown.find((item) => item.name === 'motivation_signal')
    expect(signal).toBeDefined()
    expect(signal!.value).toBeGreaterThan(0)
  })

  it('gives negative motivation_signal when motivationScore is below 50', () => {
    const result = calculateProactiveScore(
      makeContext({ runtimeState: makeRuntimeState({ motivationScore: 22 }) })
    )
    const signal = result.breakdown.find((item) => item.name === 'motivation_signal')
    expect(signal).toBeDefined()
    expect(signal!.value).toBeLessThan(0)
  })

  it('gives relationship_signal when intimacyScore is above 35', () => {
    const result = calculateProactiveScore(
      makeContext({ runtimeState: makeRuntimeState({ intimacyScore: 60 }) })
    )
    const signal = result.breakdown.find((item) => item.name === 'relationship_signal')
    expect(signal).toBeDefined()
    expect(signal!.value).toBeGreaterThan(0)
  })

  it('gives negative relationship_signal when intimacyScore is below 35', () => {
    const result = calculateProactiveScore(
      makeContext({ runtimeState: makeRuntimeState({ intimacyScore: 10 }) })
    )
    const signal = result.breakdown.find((item) => item.name === 'relationship_signal')
    expect(signal).toBeDefined()
    expect(signal!.value).toBeLessThan(0)
  })

  it('gives emotion_signal for focused state', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({ emotionState: 'focused' }),
        settings: { ...DEFAULT_SETTINGS, enableEmotionModel: true } as SettingsRecord
      })
    )
    const signal = result.breakdown.find((item) => item.name === 'emotion_signal')
    expect(signal).toBeDefined()
    expect(signal!.value).toBe(5)
  })

  it('gives positive emotion_signal for warm state', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({ emotionState: 'warm' }),
        settings: { ...DEFAULT_SETTINGS, enableEmotionModel: true } as SettingsRecord
      })
    )
    const signal = result.breakdown.find((item) => item.name === 'emotion_signal')
    expect(signal).toBeDefined()
    expect(signal!.value).toBe(6)
  })

  it('gives negative emotion_signal for drained state', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({ emotionState: 'drained' }),
        settings: { ...DEFAULT_SETTINGS, enableEmotionModel: true } as SettingsRecord
      })
    )
    const signal = result.breakdown.find((item) => item.name === 'emotion_signal')
    expect(signal).toBeDefined()
    expect(signal!.value).toBe(-8)
  })

  it('gives negative emotion_signal for concerned state', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({ emotionState: 'concerned' }),
        settings: { ...DEFAULT_SETTINGS, enableEmotionModel: true } as SettingsRecord
      })
    )
    const signal = result.breakdown.find((item) => item.name === 'emotion_signal')
    expect(signal).toBeDefined()
    expect(signal!.value).toBe(-4)
  })

  it('skips emotion_signal when enableEmotionModel is false', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({ emotionState: 'drained' }),
        settings: { ...DEFAULT_SETTINGS, enableEmotionModel: false } as SettingsRecord
      })
    )
    expect(result.breakdown.find((item) => item.name === 'emotion_signal')).toBeUndefined()
  })

  it('applies quiet_hours_penalty during quiet hours', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '',
            localHour: 3,
            dayPart: 'late_night',
            isQuietHours: true
          }
        }),
        settings: { ...DEFAULT_SETTINGS, enableEnvironmentAwareness: true } as SettingsRecord
      })
    )
    expect(result.breakdown.find((item) => item.name === 'quiet_hours_penalty')?.value).toBe(-18)
  })

  it('applies late_night_penalty for late_night dayPart', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '',
            localHour: 3,
            dayPart: 'late_night',
            isQuietHours: true
          }
        }),
        settings: { ...DEFAULT_SETTINGS, enableEnvironmentAwareness: true } as SettingsRecord
      })
    )
    expect(result.breakdown.find((item) => item.name === 'late_night_penalty')?.value).toBe(-10)
  })

  it('gives morning_freshness_bonus for morning dayPart', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '',
            localHour: 9,
            dayPart: 'morning',
            isQuietHours: false
          }
        }),
        settings: { ...DEFAULT_SETTINGS, enableEnvironmentAwareness: true } as SettingsRecord
      })
    )
    expect(result.breakdown.find((item) => item.name === 'morning_freshness_bonus')?.value).toBe(4)
  })

  it('gives evening_reflection_bonus for evening dayPart', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '',
            localHour: 20,
            dayPart: 'evening',
            isQuietHours: false
          }
        }),
        settings: { ...DEFAULT_SETTINGS, enableEnvironmentAwareness: true } as SettingsRecord
      })
    )
    expect(result.breakdown.find((item) => item.name === 'evening_reflection_bonus')?.value).toBe(3)
  })

  it('skips environment factors when enableEnvironmentAwareness is false', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '',
            localHour: 3,
            dayPart: 'late_night',
            isQuietHours: true
          }
        }),
        settings: { ...DEFAULT_SETTINGS, enableEnvironmentAwareness: false } as SettingsRecord
      })
    )
    expect(result.breakdown.find((item) => item.name === 'quiet_hours_penalty')).toBeUndefined()
    expect(result.breakdown.find((item) => item.name === 'late_night_penalty')).toBeUndefined()
  })

  it('applies weather_context for extreme weather', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '暴雨预警',
            localHour: 14,
            dayPart: 'afternoon',
            isQuietHours: false
          }
        }),
        settings: { ...DEFAULT_SETTINGS, enableEnvironmentAwareness: true } as SettingsRecord
      })
    )
    expect(result.breakdown.find((item) => item.name === 'weather_context')?.value).toBe(5)
  })

  it('skips weather_context for default weather summary', () => {
    const result = calculateProactiveScore(
      makeContext({
        runtimeState: makeRuntimeState({
          environment: {
            timezone: 'Asia/Hong_Kong',
            locationLabel: 'Hong Kong',
            weatherSummary: '室内工作场景，默认不主动引用天气，除非用户手动配置了明确天气。',
            localHour: 14,
            dayPart: 'afternoon',
            isQuietHours: false
          }
        }),
        settings: { ...DEFAULT_SETTINGS, enableEnvironmentAwareness: true } as SettingsRecord
      })
    )
    expect(result.breakdown.find((item) => item.name === 'weather_context')).toBeUndefined()
  })
})
