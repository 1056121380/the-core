import { describe, it, expect } from 'vitest'
import { selectMemories } from './memorySelector'
import type { MemoryRecord, MessageRecord } from '@shared/types'

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 1,
    type: 'project_fact',
    content: 'This is a test memory',
    weight: 0.8,
    isPinned: false,
    sessionId: null,
    source: 'manual',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 1,
    sessionId: 'test',
    role: 'user',
    content: 'Hello',
    segments: ['Hello'],
    topicType: null,
    isProactive: false,
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

describe('selectMemories', () => {
  it('returns empty arrays when no memories exist', () => {
    const result = selectMemories({
      memories: [],
      recentMessages: [],
      sessionId: 'test'
    })
    expect(result.all).toEqual([])
    expect(result.projectFacts).toEqual([])
    expect(result.userPreferences).toEqual([])
  })

  it('categorizes memories by type', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ id: 1, type: 'project_fact', content: 'project fact' }),
      makeMemory({ id: 2, type: 'project_goal', content: 'project goal' }),
      makeMemory({ id: 3, type: 'user_preference', content: 'user preference' }),
      makeMemory({ id: 4, type: 'style_rule', content: 'style rule' }),
      makeMemory({ id: 5, type: 'recent_summary', content: 'recent summary' }),
      makeMemory({ id: 6, type: 'user_fact', content: 'user fact' })
    ]
    const result = selectMemories({
      memories,
      recentMessages: [],
      sessionId: 'test'
    })
    expect(result.projectFacts).toHaveLength(1)
    expect(result.projectGoals).toHaveLength(1)
    expect(result.userPreferences).toHaveLength(1)
    expect(result.styleRules).toHaveLength(1)
    expect(result.recentSummaries).toHaveLength(1)
    expect(result.userFacts).toHaveLength(1)
  })

  it('ranks pinned memories ahead of unpinned ones', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ id: 1, type: 'project_fact', content: 'normal memory', isPinned: false, weight: 0.6 }),
      makeMemory({ id: 2, type: 'project_fact', content: 'pinned memory', isPinned: true, weight: 0.9 })
    ]
    const result = selectMemories({
      memories,
      recentMessages: [],
      sessionId: 'test'
    })
    expect(result.projectFacts[0].id).toBe(2)
  })

  it('ranks higher weight memories first', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ id: 1, type: 'project_fact', content: 'low weight', weight: 0.3 }),
      makeMemory({ id: 2, type: 'project_fact', content: 'high weight', weight: 0.9 })
    ]
    const result = selectMemories({
      memories,
      recentMessages: [],
      sessionId: 'test'
    })
    expect(result.projectFacts[0].id).toBe(2)
  })

  it('boosts memories that match query tokens', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ id: 1, type: 'project_fact', content: 'weather is nice', weight: 0.8 }),
      makeMemory({ id: 2, type: 'project_fact', content: 'proactive chat is live', weight: 0.8 })
    ]
    const result = selectMemories({
      memories,
      recentMessages: [],
      sessionId: 'test',
      query: 'proactive chat'
    })
    expect(result.projectFacts[0].id).toBe(2)
  })

  it('boosts session-scoped memories for the matching session', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ id: 1, type: 'project_fact', content: 'global memory', sessionId: null, weight: 0.8 }),
      makeMemory({ id: 2, type: 'project_fact', content: 'session memory', sessionId: 'test', weight: 0.8 })
    ]
    const result = selectMemories({
      memories,
      recentMessages: [],
      sessionId: 'test'
    })
    expect(result.projectFacts[0].id).toBe(2)
  })

  it('prefers persona-layer memories over equally relevant long-term memories', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ id: 1, type: 'project_fact', content: 'prefer short direct replies', weight: 0.8 }),
      makeMemory({ id: 2, type: 'user_preference', content: 'prefer short direct replies', weight: 0.8 })
    ]
    const result = selectMemories({
      memories,
      recentMessages: [],
      sessionId: 'test',
      query: 'prefer short direct replies'
    })
    const personaItem = result.debugItems.find((item) => item.memoryId === 2)
    const longTermItem = result.debugItems.find((item) => item.memoryId === 1)
    expect(personaItem).toBeDefined()
    expect(longTermItem).toBeDefined()
    expect(personaItem!.layer).toBe('persona')
    expect(longTermItem!.layer).toBe('long_term')
    expect(personaItem!.score).toBeGreaterThan(longTermItem!.score)
    expect(result.debugItems[0].memoryId).toBe(2)
  })

  it('returns debug items with scores', () => {
    const memories: MemoryRecord[] = [makeMemory({ id: 1, type: 'project_fact', content: 'test' })]
    const result = selectMemories({
      memories,
      recentMessages: [],
      sessionId: 'test'
    })
    expect(result.debugItems).toHaveLength(1)
    expect(result.debugItems[0].memoryId).toBe(1)
    expect(typeof result.debugItems[0].score).toBe('number')
  })

  it('gives persona layer a higher bonus than long-term layer', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ id: 1, type: 'project_fact', content: 'identical content', weight: 0.5 }),
      makeMemory({ id: 2, type: 'style_rule', content: 'identical content', weight: 0.5 })
    ]
    const result = selectMemories({
      memories,
      recentMessages: [],
      sessionId: 'test'
    })
    const longTerm = result.debugItems.find((item) => item.memoryId === 1)!
    const persona = result.debugItems.find((item) => item.memoryId === 2)!
    expect(persona.layer).toBe('persona')
    expect(longTerm.layer).toBe('long_term')
    expect(persona.score).toBeGreaterThan(longTerm.score)
  })

  it('returns query tokens', () => {
    const result = selectMemories({
      memories: [],
      recentMessages: [],
      sessionId: 'test',
      query: 'proactive chat test'
    })
    expect(result.queryTokens.length).toBeGreaterThan(0)
  })

  it('respects per-type limits', () => {
    const memories: MemoryRecord[] = Array.from({ length: 10 }, (_, index) =>
      makeMemory({
        id: index + 1,
        type: 'project_fact',
        content: `fact ${index}`,
        weight: 0.5 + index * 0.05
      })
    )
    const result = selectMemories({
      memories,
      recentMessages: [],
      sessionId: 'test'
    })
    expect(result.projectFacts.length).toBeLessThanOrEqual(3)
  })

  it('uses recent messages as retrieval context', () => {
    const messages: MessageRecord[] = [
      makeMessage({ content: 'I am working on the memory system', segments: ['I am working on the memory system'] })
    ]
    const memories: MemoryRecord[] = [
      makeMemory({ id: 1, type: 'project_fact', content: 'memory system design', weight: 0.8 }),
      makeMemory({ id: 2, type: 'project_fact', content: 'weather forecast feature', weight: 0.8 })
    ]
    const result = selectMemories({
      memories,
      recentMessages: messages,
      sessionId: 'test'
    })
    expect(result.projectFacts[0].id).toBe(1)
  })
})
