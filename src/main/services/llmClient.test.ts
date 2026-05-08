import { describe, it, expect, vi } from 'vitest'
import { detectProtocol, getLlmConfig } from './llmClient'

describe('detectProtocol', () => {
  it('detects anthropic protocol from URL ending with /anthropic', () => {
    expect(detectProtocol('https://api.example.com/anthropic')).toBe('anthropic')
  })

  it('detects anthropic protocol from URL ending with /anthropic/v1', () => {
    expect(detectProtocol('https://api.example.com/anthropic/v1')).toBe('anthropic')
  })

  it('defaults to openai protocol for standard URLs', () => {
    expect(detectProtocol('https://api.openai.com/v1')).toBe('openai')
  })

  it('defaults to openai for minimaxi URLs without anthropic suffix', () => {
    expect(detectProtocol('https://api.minimaxi.com/v1')).toBe('openai')
  })
})

describe('getLlmConfig', () => {
  it('returns null when no API key is available anywhere', () => {
    vi.stubEnv('MINIMAX_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('MINIMAX_BASE_URL', '')
    vi.stubEnv('ANTHROPIC_BASE_URL', '')
    vi.stubEnv('OPENAI_BASE_URL', '')
    expect(getLlmConfig({ llmApiKey: '' })).toBeNull()
  })

  it('returns config with API key from settings', () => {
    const config = getLlmConfig({
      llmApiKey: 'sk-test',
      llmBaseUrl: 'https://api.test.com',
      llmModel: 'test-model',
      mockMode: false,
      llmEnabled: true
    })
    expect(config).not.toBeNull()
    expect(config!.apiKey).toBe('sk-test')
    expect(config!.baseUrl).toBe('https://api.test.com')
    expect(config!.model).toBe('test-model')
  })

  it('detects protocol based on base URL', () => {
    const config = getLlmConfig({
      llmApiKey: 'sk-test',
      llmBaseUrl: 'https://api.minimaxi.com/anthropic',
      llmModel: 'test',
      mockMode: false,
      llmEnabled: true
    })
    expect(config!.protocol).toBe('anthropic')
  })
})
