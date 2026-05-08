// ============================================================
// 数字人核心类型定义
// 所有核心引擎共享的类型
// ============================================================

import type { EmotionState, UserState, DayPart, MemoryType, MemorySource, TopicType, ProactiveDecision } from '@shared/types'

// --- Identity Types ---
export interface PersonalityTrait {
  trait: string
  weight: number // 0-1
}

export interface SpeakingStyle {
  rules: string[]           // 应该这样做
  forbidden: string[]       // 不要这样做
  examples?: string[]       // 示例对话
}

export interface VoiceConfig {
  gender: 'male' | 'female' | 'neutral'
  speed: number              // 相对正常语速的倍率
  pitch?: 'low' | 'medium' | 'high'
  emotionMapping: Partial<Record<EmotionState, { speed: number; pitch: 'soft' | 'normal' | 'higher' }>>
}

export interface IdentityProfile {
  name: string
  age?: string
  constellation?: string
  personality: {
    traits: PersonalityTrait[]
    rules: string[]
    forbidden: string[]
    examples?: string[]
  }
  backstory: string
  voice: VoiceConfig
}

export interface IdentitySummary {
  name: string
  shortDesc: string   // 一句话描述
  personality: string // 性格要点
}

// --- Memory Types ---
export interface MemoryNode {
  id: number
  type: MemoryType
  content: string
  weight: number
  isPinned: boolean
  sessionId: string | null
  source: MemorySource
  createdAt: string
  updatedAt: string
  metadata?: {
    deadline?: string | null
    taskStatus?: 'open' | 'done' | 'archived'
    topicType?: TopicType | null
    confidence?: number
    hitCount?: number
    lastHitAt?: string | null
    memoryLayer?: 'short_term' | 'persona' | 'long_term'
    importanceReason?: string | null
  }
}

export interface MemoryQuery {
  sessionId?: string | null
  includeGlobal?: boolean
  limit?: number
  types?: MemoryType[]
  sources?: MemorySource[]
  query?: string
}

// --- Relationship Types ---
export interface RelationshipScore {
  intimacy: number           // 0-100, 亲密度
  trust: number              // 0-100, 信任度
  familiarity: number        // 0-100, 熟悉度
}

export interface RelationshipState {
  score: RelationshipScore
  lastInteractionAt: string | null
  interactionCount: number
  positiveFeedbackCount: number
  negativeFeedbackCount: number
  preferredHours: number[]
  preferredSegmentCount: number | null
  preferredContentLength: number | null
}

// --- Lifecycle Types ---
export interface LifecycleSchedule {
  wakeHour: number
  sleepHour: number
  activeHours: { start: number; end: number }[]
  quietHours: { start: number; end: number }[]
}

export interface LifecycleState {
  currentHour: number
  dayPart: DayPart
  emotion: EmotionState
  emotionIntensity: number
  schedule: LifecycleSchedule
  isActiveHour: boolean
  isQuietHour: boolean
}

// --- Context Types ---
export interface DialogContext {
  sessionId: string
  userMessage: string
  recentMessages: MemoryNode[]
  memories: MemoryNode[]
  relationship: RelationshipState
  lifecycle: LifecycleState
  emotion: EmotionState
  emotionIntensity: number
}

export interface ProactiveContext {
  sessionId: string
  memories: MemoryNode[]
  recentMessages: MemoryNode[]
  relationship: RelationshipState
  lifecycle: LifecycleState
  emotion: EmotionState
  emotionIntensity: number
  runtimeState: {
    currentTime?: string
    userState: UserState
    todayProactiveCount: number
    recentlyRejected: boolean
    lastProactiveAt: string | null
  }
  topicWeights: Record<TopicType, number>
}

// --- Output Types ---
export interface DialogOutput {
  text: string
  segments: string[]
  emotion?: EmotionState
}

export interface ProactiveOutput {
  shouldSpeak: boolean
  topicType: TopicType
  segments: string[]
  reason: string
}

export interface MultimodalOutput {
  text?: string
  image?: ImageData
  audio?: AudioData
}

export interface ImageData {
  url?: string
  base64?: string
  caption?: string
  metadata?: {
    width?: number
    height?: number
    style?: string
  }
}

export interface AudioData {
  url?: string
  base64?: string
  duration?: number
  metadata?: {
    voiceConfig?: VoiceConfig
    emotion?: EmotionState
  }
}

// --- Adapter Interfaces ---
export interface LLMAdapter {
  chat(prompt: { systemPrompt: string; messages: Array<{ role: string; content: string }>; temperature?: number }): Promise<string>
  isAvailable(): boolean
}

export interface ImageAdapter {
  generate(prompt: string, options?: { size?: 'square' | 'landscape' | 'portrait' }): Promise<ImageData>
  isAvailable(): boolean
}

export interface TTSAdapter {
  speak(text: string, voiceConfig: VoiceConfig, emotion?: EmotionState): Promise<AudioData>
  isAvailable(): boolean
}

export interface ChannelAdapter {
  sendMessage(output: MultimodalOutput): Promise<void>
  onMessage(handler: (message: { content: string; sessionId: string }) => void): void
  getUserState(): UserState
}
