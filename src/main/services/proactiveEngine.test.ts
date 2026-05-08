import { describe, it, expect } from 'vitest'
import { ProactiveEngine } from './proactiveEngine'
import type { RuntimeState, SettingsRecord } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'

function makeSettings(overrides: Partial<SettingsRecord> = {}): SettingsRecord {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

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

function makeEngine() {
  const engine = Object.create(ProactiveEngine.prototype) as ProactiveEngine
  return engine
}

describe('ProactiveEngine hard rules', () => {
  it('blocks when user is in cooldown with future cooldownUntil', () => {
    const engine = makeEngine()
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const reason = engine.evaluateHardRules(
      'test',
      makeSettings(),
      makeRuntimeState({
        userState: 'cooldown',
        cooldownUntil: future
      })
    )
    expect(reason).toContain('cooldown')
  })

  it('blocks when user is away', () => {
    const engine = makeEngine()
    const reason = engine.evaluateHardRules(
      'test',
      makeSettings(),
      makeRuntimeState({ userState: 'away' })
    )
    expect(reason).toContain('away')
  })

  it('blocks when daily limit is reached', () => {
    const engine = makeEngine()
    const reason = engine.evaluateHardRules(
      'test',
      makeSettings({ dailyLimit: 2 }),
      makeRuntimeState({ todayProactiveCount: 2 })
    )
    expect(reason).toContain('上限')
  })

  it('blocks when recently rejected', () => {
    const engine = makeEngine()
    const reason = engine.evaluateHardRules(
      'test',
      makeSettings(),
      makeRuntimeState({ recentlyRejected: true })
    )
    expect(reason).toContain('别打扰')
  })

  it('blocks when within active conversation window', () => {
    const engine = makeEngine()
    const reason = engine.evaluateHardRules(
      'test',
      makeSettings({ activeConversationBlockMinutes: 5 }),
      makeRuntimeState({
        lastInteractionAt: new Date(Date.now() - 60 * 1000).toISOString()
      })
    )
    expect(reason).toContain('对话')
  })

  it('blocks during quiet hours when environment awareness is on', () => {
    const engine = makeEngine()
    const reason = engine.evaluateHardRules(
      'test',
      makeSettings({ enableEnvironmentAwareness: true }),
      makeRuntimeState({
        environment: {
          timezone: 'Asia/Hong_Kong',
          locationLabel: 'Hong Kong',
          weatherSummary: '',
          localHour: 3,
          dayPart: 'late_night',
          isQuietHours: true
        }
      })
    )
    expect(reason).toContain('安静时段')
  })

  it('blocks when min time between proactive not elapsed', () => {
    const engine = makeEngine()
    const reason = engine.evaluateHardRules(
      'test',
      makeSettings({ minMinutesBetweenProactive: 30 }),
      makeRuntimeState({
        lastProactiveAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
      })
    )
    expect(reason).toContain('分钟')
  })

  it('returns null when all rules pass', () => {
    const engine = makeEngine()
    const reason = engine.evaluateHardRules(
      'test',
      makeSettings(),
      makeRuntimeState({
        lastProactiveAt: new Date(Date.now() - 120 * 60 * 1000).toISOString()
      })
    )
    expect(reason).toBeNull()
  })
})
