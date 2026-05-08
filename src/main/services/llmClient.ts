import { DEFAULT_PERSONA } from '@shared/constants'
import { OpenAiResponseSchema, AnthropicResponseSchema } from '@shared/schema'
import type { SettingsRecord } from '@shared/types'
import { logger } from '@main/services/logger'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic'
}

interface CreateChatOptions {
  systemPrompt?: string
  messages: ChatMessage[]
  temperature?: number
  timeoutMs?: number
  maxRetries?: number
}

type LlmSettings = Pick<SettingsRecord, 'llmEnabled' | 'llmApiKey' | 'llmBaseUrl' | 'llmModel' | 'mockMode'>

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2

function createRequestSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function detectProtocol(baseUrl: string): 'openai' | 'anthropic' {
  return /\/anthropic\/?$/.test(baseUrl) || /\/anthropic\/v1\/?$/.test(baseUrl) ? 'anthropic' : 'openai'
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504
}

function backoffDelay(attempt: number, baseMs = 1000): number {
  return baseMs * Math.pow(2, attempt) + Math.random() * 500
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  label: string
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt >= maxRetries) break

      const isRetryable =
        error instanceof Error &&
        (error.name === 'AbortError' ||
          error.message.includes('429') ||
          error.message.includes('503') ||
          error.message.includes('502') ||
          error.message.includes('504') ||
          error.message.includes('fetch') ||
          error.message.includes('network'))

      if (!isRetryable) break

      const delay = backoffDelay(attempt)
      logger.warn('llm', `Retrying ${label} after error.`, {
        attempt: attempt + 1,
        maxRetries,
        delayMs: Math.round(delay),
        error: error instanceof Error ? error.message : String(error)
      })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

export function getLlmConfig(settings?: Partial<LlmSettings>): LlmConfig | null {
  const apiKey =
    settings?.llmApiKey?.trim() ||
    getEnv('MINIMAX_API_KEY') ||
    getEnv('OPENAI_API_KEY') ||
    getEnv('ANTHROPIC_API_KEY')

  if (!apiKey) {
    return null
  }

  const baseUrl =
    settings?.llmBaseUrl?.trim() ||
    getEnv('MINIMAX_BASE_URL') ||
    getEnv('ANTHROPIC_BASE_URL') ||
    getEnv('OPENAI_BASE_URL') ||
    'https://api.minimaxi.com/anthropic'

  return {
    apiKey,
    baseUrl,
    model:
      settings?.llmModel?.trim() ||
      getEnv('MINIMAX_MODEL') ||
      getEnv('ANTHROPIC_MODEL') ||
      getEnv('OPENAI_MODEL') ||
      'MiniMax-M2.7',
    protocol: detectProtocol(baseUrl)
  }
}

async function createOpenAiChatCompletion(config: LlmConfig, options: CreateChatOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  logger.info('llm', 'Starting OpenAI-compatible request.', {
    baseUrl: config.baseUrl,
    model: config.model,
    protocol: config.protocol,
    messageCount: options.messages.length,
    timeoutMs
  })
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: createRequestSignal(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: options.temperature ?? 0.7,
      messages: [{ role: 'system', content: options.systemPrompt ?? DEFAULT_PERSONA }, ...options.messages]
    })
  })

  if (!response.ok) {
    const body = await response.text()
    logger.error('llm', 'OpenAI-compatible request failed.', {
      status: response.status,
      body,
      baseUrl: config.baseUrl,
      model: config.model
    })
    throw new Error(`LLM request failed: ${response.status} ${body}`)
  }

  const rawData = await response.json()
  const parseResult = OpenAiResponseSchema.safeParse(rawData)
  if (!parseResult.success) {
    logger.error('llm', 'OpenAI-compatible response schema invalid.', {
      model: config.model,
      errors: parseResult.error.message
    })
    throw new Error('LLM response schema invalid.')
  }

  const content = parseResult.data.choices?.[0]?.message?.content?.trim()
  if (!content) {
    logger.error('llm', 'OpenAI-compatible response missing content.', {
      model: config.model
    })
    throw new Error('LLM response did not contain message content.')
  }

  logger.info('llm', 'OpenAI-compatible request succeeded.', {
    model: config.model,
    contentLength: content.length
  })
  return content
}

async function createAnthropicChatCompletion(config: LlmConfig, options: CreateChatOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  logger.info('llm', 'Starting Anthropic-compatible request.', {
    baseUrl: config.baseUrl,
    model: config.model,
    protocol: config.protocol,
    messageCount: options.messages.length,
    timeoutMs
  })
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    signal: createRequestSignal(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.model,
      system: options.systemPrompt ?? DEFAULT_PERSONA,
      max_tokens: 512,
      temperature: options.temperature ?? 0.7,
      messages: options.messages
        .filter((item) => item.role !== 'system')
        .map((item) => ({
          role: item.role,
          content: item.content
        }))
    })
  })

  if (!response.ok) {
    const body = await response.text()
    logger.error('llm', 'Anthropic-compatible request failed.', {
      status: response.status,
      body,
      baseUrl: config.baseUrl,
      model: config.model
    })
    throw new Error(`LLM request failed: ${response.status} ${body}`)
  }

  const rawData = await response.json()
  const parseResult = AnthropicResponseSchema.safeParse(rawData)
  if (!parseResult.success) {
    logger.error('llm', 'Anthropic-compatible response schema invalid.', {
      model: config.model,
      errors: parseResult.error.message
    })
    throw new Error('LLM response schema invalid.')
  }

  const content = parseResult.data.content?.find((item) => item.type === 'text')
  if (content && 'text' in content && content.text.trim()) {
    logger.info('llm', 'Anthropic-compatible request succeeded.', {
      model: config.model,
      contentLength: content.text.trim().length
    })
    return content.text.trim()
  }

  logger.error('llm', 'Anthropic-compatible response missing usable content.', {
    model: config.model
  })
  throw new Error('LLM response did not contain visible text content.')
}

export async function createChatCompletion(
  options: CreateChatOptions,
  settings?: Partial<LlmSettings>
): Promise<string> {
  const config = getLlmConfig(settings)
  if (!config) {
    throw new Error('Missing LLM configuration.')
  }

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES

  const doRequest = async (): Promise<string> => {
    if (config.protocol === 'anthropic') {
      return createAnthropicChatCompletion(config, options)
    }
    return createOpenAiChatCompletion(config, options)
  }

  return withRetry(doRequest, maxRetries, `${config.protocol}/${config.model}`)
}

export function shouldUseLiveLlm(settings: LlmSettings): boolean {
  return settings.llmEnabled && Boolean(getLlmConfig(settings))
}
