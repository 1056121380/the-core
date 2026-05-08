import { describe, it, expect } from 'vitest'
import { normalizeSegmentsFromText, normalizeSegments } from './segmentNormalizer'

describe('normalizeSegmentsFromText', () => {
  it('splits Chinese sentences by period', () => {
    const result = normalizeSegmentsFromText('你好。我在。', 6)
    expect(result).toEqual(['你好。', '我在。'])
  })

  it('splits by exclamation mark', () => {
    const result = normalizeSegmentsFromText('好的！收到！', 6)
    expect(result).toEqual(['好的！', '收到！'])
  })

  it('splits by question mark', () => {
    const result = normalizeSegmentsFromText('你好吗？我很好。', 6)
    expect(result).toEqual(['你好吗？', '我很好。'])
  })

  it('splits by semicolon', () => {
    const result = normalizeSegmentsFromText('第一点；第二点。', 6)
    expect(result).toEqual(['第一点；', '第二点。'])
  })

  it('merges when exceeding maxSegments', () => {
    const result = normalizeSegmentsFromText('一。二。三。四。', 2)
    expect(result).toHaveLength(2)
  })

  it('returns a single segment when no sentence endings exist', () => {
    const result = normalizeSegmentsFromText('没有标点的一段话', 6)
    expect(result).toEqual(['没有标点的一段话'])
  })

  it('handles empty text', () => {
    const result = normalizeSegmentsFromText('', 6)
    expect(result).toEqual([])
  })

  it('handles whitespace-only text', () => {
    const result = normalizeSegmentsFromText('   ', 6)
    expect(result).toEqual([])
  })

  it('splits by newline', () => {
    const result = normalizeSegmentsFromText('第一行。\n第二行。', 6)
    expect(result).toEqual(['第一行。', '第二行。'])
  })

  it('respects maxSegments limit of 1', () => {
    const result = normalizeSegmentsFromText('一。二。三。', 1)
    expect(result).toHaveLength(1)
  })

  it('does not split on decimal numbers', () => {
    const result = normalizeSegmentsFromText('价格是1.5元。很便宜。', 6)
    expect(result).toEqual(['价格是1.5元。', '很便宜。'])
  })

  it('handles English sentence endings', () => {
    const result = normalizeSegmentsFromText('Hello! How are you? Fine.', 6)
    expect(result).toEqual(['Hello!', 'How are you?', 'Fine.'])
  })

  it('clamps maxSegments to 6', () => {
    const text = '一。二。三。四。五。六。七。'
    const result = normalizeSegmentsFromText(text, 100)
    expect(result.length).toBeLessThanOrEqual(6)
  })

  it('clamps maxSegments to at least 1', () => {
    const result = normalizeSegmentsFromText('你好。', 0)
    expect(result).toHaveLength(1)
  })
})

describe('normalizeSegments', () => {
  it('keeps already normalized segments', () => {
    const result = normalizeSegments(['你好。', '我在。'], 6)
    expect(result).toEqual(['你好。', '我在。'])
  })

  it('re-splits a combined segment', () => {
    const result = normalizeSegments(['你好。我在。'], 6)
    expect(result).toEqual(['你好。', '我在。'])
  })

  it('handles an empty array', () => {
    const result = normalizeSegments([], 6)
    expect(result).toEqual([])
  })

  it('handles a single plain segment', () => {
    const result = normalizeSegments(['你好世界'], 6)
    expect(result).toEqual(['你好世界'])
  })
})
