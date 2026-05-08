// ============================================================
// Adapters - 可插拔的外部服务适配器
// 定义 LLM、Image、TTS、Channel 的标准接口
// 实现可替换的插口架构
// ============================================================

import type { ImageData, AudioData, VoiceConfig } from '@main/types/digitalHuman'
import type { EmotionState } from '@shared/types'
import type { SettingsRecord } from '@shared/types'
import { createChatCompletion, shouldUseLiveLlm, getLlmConfig } from '@main/services/llmClient'

// --- LLM Adapter ---
export interface LLMAdapter {
  chat(prompt: { systemPrompt: string; messages: Array<{ role: string; content: string }>; temperature?: number }): Promise<string>
  isAvailable(): boolean
}

export class LLMAdapterImpl implements LLMAdapter {
  constructor(private settings: SettingsRecord) {}

  async chat(prompt: { systemPrompt: string; messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>; temperature?: number }): Promise<string> {
    if (!shouldUseLiveLlm(this.settings)) {
      throw new Error('LLM not configured')
    }
    return createChatCompletion(prompt, this.settings)
  }

  isAvailable(): boolean {
    return shouldUseLiveLlm(this.settings)
  }
}

// --- Image Adapter ---
export interface ImageAdapter {
  generate(prompt: string, options?: { size?: 'square' | 'landscape' | 'portrait' }): Promise<ImageData>
  isAvailable(): boolean
}

// GPT Image / DALL-E / Stable Diffusion 等可实现此接口
export class ImageAdapterImpl implements ImageAdapter {
  constructor(private apiKey?: string, private baseUrl?: string) {}

  async generate(prompt: string, options?: { size?: 'square' | 'landscape' | 'portrait' }): Promise<ImageData> {
    // TODO: 实现图片生成调用
    // 示例：调用 OpenAI DALL-E / GPT Image / Midjourney API
    throw new Error('ImageAdapter not implemented - TODO: integrate GPT Image 2 or Stable Diffusion')
  }

  isAvailable(): boolean {
    // TODO: 检查 API 配置
    return false
  }
}

// --- TTS Adapter ---
export interface TTSAdapter {
  speak(text: string, voiceConfig: VoiceConfig, emotion?: EmotionState): Promise<AudioData>
  isAvailable(): boolean
}

export class TTSAdapterImpl implements TTSAdapter {
  constructor(private apiKey?: string, private baseUrl?: string) {}

  async speak(
    text: string,
    voiceConfig: VoiceConfig,
    emotion: EmotionState = 'steady'
  ): Promise<AudioData> {
    // TODO: 实现 TTS 调用
    // 示例：调用 Azure TTS / 讯飞 / 火山引擎
    const emotionParams = voiceConfig.emotionMapping[emotion] ?? { speed: 1.0, pitch: 'normal' as const }

    // TODO: 实际调用 TTS API
    throw new Error('TTSAdapter not implemented - TODO: integrate Azure TTS or similar')
  }

  isAvailable(): boolean {
    return false
  }
}

// --- Channel Adapter ---
export interface ChannelAdapter {
  sendMessage(output: { text?: string; image?: ImageData; audio?: AudioData }): Promise<void>
  onMessage(handler: (message: { content: string; sessionId: string }) => void): void
  getUserState(): 'idle' | 'active' | 'away' | 'returned' | 'cooldown'
}

// 微信、企业微信、Telegram 等可实现此接口
export class ChannelAdapterImpl implements ChannelAdapter {
  async sendMessage(output: { text?: string; image?: ImageData; audio?: AudioData }): Promise<void> {
    // TODO: 实现消息发送
    throw new Error('ChannelAdapter not implemented - TODO: integrate WeChat or other channels')
  }

  onMessage(handler: (message: { content: string; sessionId: string }) => void): void {
    // TODO: 实现消息监听
  }

  getUserState(): 'idle' | 'active' | 'away' | 'returned' | 'cooldown' {
    return 'idle'
  }
}

// --- Adapter Factory ---
export function createLLMAdapter(settings: SettingsRecord): LLMAdapter {
  return new LLMAdapterImpl(settings)
}

export function createImageAdapter(apiKey?: string, baseUrl?: string): ImageAdapter {
  return new ImageAdapterImpl(apiKey, baseUrl)
}

export function createTTSAdapter(apiKey?: string, baseUrl?: string): TTSAdapter {
  return new TTSAdapterImpl(apiKey, baseUrl)
}

export function createChannelAdapter(): ChannelAdapter {
  return new ChannelAdapterImpl()
}
