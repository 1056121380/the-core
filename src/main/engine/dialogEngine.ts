// ============================================================
// DialogEngine - 数字人对话引擎
// 负责生成对话回复和主动消息
// 整合了 chatResponder.ts 和 messageGenerator.ts 的核心逻辑
// ============================================================

import type {
  DialogContext,
  ProactiveOutput,
  MultimodalOutput,
  MemoryNode
} from '@main/types/digitalHuman'
import type { MessageRecord, SettingsRecord, TopicType, EmotionState } from '@shared/types'
import { DEFAULT_PERSONA } from '@shared/constants'
import { createChatCompletion, shouldUseLiveLlm, getLlmConfig } from '@main/services/llmClient'
import { identityEngine } from './identityEngine'
import { selectMemories } from '@main/services/memorySelector'
import { logger } from '@main/services/logger'

// --- 工具函数 ---
function normalizeText(text: string): string {
  return text.trim().toLowerCase()
}

function stripEmoji(text: string): string {
  return text.replace(/[\u{1F300}-\u{1FAFF}]/gu, '').replace(/[\u{2600}-\u{27BF}]/gu, '').replace(/\s{2,}/g, ' ').trim()
}

function stripMarkdownFormatting(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^\s*[-*+]\s+/gm, '').replace(/^>\s+/gm, '').replace(/\[(.*?)\]\((.*?)\)/g, '$1').trim()
}

function stripInternalContextLeak(text: string): string {
  const leakMarkers = ['上一轮用户重点', '当前用户在问', '最近助手已回复', 'recent_summaries', 'project_facts', 'project_goals', 'user_facts', 'user_preferences', 'style_rules', 'tasks:']
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !leakMarkers.some((m) => l.includes(m)))
  let cleaned = lines.join('\n').trim()
  for (const marker of leakMarkers) {
    cleaned = cleaned.replace(new RegExp(`${marker}[：:][\\s\\S]*?(?=\\n|$)`, 'g'), '')
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

function clip(text: string, max = 72): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function hasDuplicateRecentUserMessage(messages: MessageRecord[]): boolean {
  const recentUserMessages = messages.filter((m) => m.role === 'user').slice(-4)
  if (recentUserMessages.length < 2) return false
  const normalized = recentUserMessages.map((m) => normalizeText(m.content))
  return normalized.some((item, index) => normalized.indexOf(item) !== index)
}

function sanitizeAssistantReply(text: string, recentMessages: MessageRecord[]): string {
  const cleaned = stripInternalContextLeak(stripMarkdownFormatting(stripEmoji(text)))
  const duplicateClaim = /(连发两条|发了两遍|重复发|又发了一次|怎么连发)/.test(cleaned)
  if (duplicateClaim && !hasDuplicateRecentUserMessage(recentMessages)) {
    return '我还在。你继续说当前问题，或者直接告诉我想先调哪一层。'
  }
  return cleaned || '我在。你直接说当前问题就行。'
}

function memorySection(label: string, memories: Array<{ content: string }>): string {
  return `${label}:\n${memories.map((m) => `- ${m.content}`).join('\n') || '- (empty)'}`
}

// --- DialogEngine 主类 ---
export class DialogEngine {
  /**
   * 处理用户消息，生成回复
   */
  async reply(
    input: {
      sessionId: string
      userMessage: string
      recentMessages: MessageRecord[]
      memories: MemoryNode[]
      settings: SettingsRecord
    }
  ): Promise<string> {
    const { sessionId, userMessage, recentMessages, memories, settings } = input

    // 选择相关记忆
    const selected = selectMemories({ memories, recentMessages, sessionId, query: userMessage }) as {
      recentSummaries: Array<{ content: string }>
      projectFacts: Array<{ content: string }>
      projectGoals: Array<{ content: string }>
      userFacts: Array<{ content: string }>
      userPreferences: Array<{ content: string }>
      styleRules: Array<{ content: string }>
      tasks: Array<{ content: string }>
    }

    if (!shouldUseLiveLlm(settings)) {
      return '还没有配置真实大模型。请在设置里填写 API Key、Base URL 和模型名，然后保存后再聊。'
    }

    // 构建历史消息
    const recentHistory = recentMessages.slice(-8)
    const history = recentHistory.flatMap((m) => {
      const content = m.segments.length > 0 ? m.segments.join('\n') : m.content
      return content ? [{ role: m.role === 'user' ? 'user' : 'assistant', content } as const] : []
    })

    const lastHistoryMessage = recentHistory[recentHistory.length - 1]
    const hasCurrentUserMessageInHistory =
      lastHistoryMessage?.role === 'user' && normalizeText(lastHistoryMessage.content) === normalizeText(userMessage)

    // 构建记忆 prompt
    const sectionsStr = [
      memorySection('recent_summaries', selected.recentSummaries),
      memorySection('project_facts', selected.projectFacts),
      memorySection('project_goals', selected.projectGoals),
      memorySection('user_facts', selected.userFacts),
      memorySection('user_preferences', selected.userPreferences),
      memorySection('style_rules', selected.styleRules),
      memorySection('tasks', selected.tasks)
    ].join('\n\n')

    const messages = hasCurrentUserMessageInHistory ? history : [...history, { role: 'user' as const, content: userMessage }]

    // 构建 systemPrompt
    const identityPrompt = identityEngine.buildSystemPrompt({
      identityProfile: settings.identityProfile,
      personaPrompt: settings.personaPrompt || DEFAULT_PERSONA,
      habitProfile: settings.habitProfile
    })

    try {
      const liveReply = await createChatCompletion(
        {
          systemPrompt: identityPrompt,
          messages,
          temperature: 0.55
        },
        settings
      )
      return sanitizeAssistantReply(liveReply, recentMessages)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return sanitizeAssistantReply(`真实模型请求失败：${reason}`, recentMessages)
    }
  }

  /**
   * 生成主动消息
   */
  async generateProactiveMessage(
    input: {
      topicType: TopicType
      userState: 'idle' | 'active' | 'away' | 'returned' | 'cooldown'
      emotion: EmotionState
      intimacyScore: number
      recentMessages: MessageRecord[]
      memories: MemoryNode[]
      settings: SettingsRecord
      preferredSegmentCount?: number | null
    }
  ): Promise<ProactiveOutput> {
    const { topicType, userState, emotion, intimacyScore, recentMessages, memories, settings, preferredSegmentCount } = input

    if (!shouldUseLiveLlm(settings)) {
      return { shouldSpeak: false, topicType, segments: [], reason: 'no_llm' }
    }

    // 选择相关记忆
    const query = recentMessages.slice(-6).map((m) => (m.segments.length > 0 ? m.segments.join(' ') : m.content)).join('\n')
    const selected = selectMemories({ memories, recentMessages, sessionId: '', query })

    const preferredSegments = Math.max(1, Math.min(6, Math.round(preferredSegmentCount ?? 3)))
    const recent = recentMessages.slice(-8).map((m) => `- ${m.segments.join(' ') || m.content}`).join('\n')

    const identityPrompt = identityEngine.buildSystemPrompt({
      identityProfile: settings.identityProfile,
      personaPrompt: settings.personaPrompt || DEFAULT_PERSONA,
      habitProfile: settings.habitProfile
    })

    const prompt = [
      `topic_type: ${topicType}`,
      `user_state: ${userState}`,
      `emotion_state: ${emotion}`,
      `intimacy_score: ${intimacyScore}`,
      memorySection('recent_summaries', selected.recentSummaries),
      memorySection('proactive_summaries', selected.proactiveSummaries),
      memorySection('project_facts', selected.projectFacts),
      memorySection('project_goals', selected.projectGoals),
      memorySection('user_facts', selected.userFacts),
      memorySection('user_preferences', selected.userPreferences),
      memorySection('tasks', selected.tasks),
      'recent_messages:',
      recent || '- (empty)',
      '要求：',
      '- 只输出 JSON，格式为 {"shouldSpeak": boolean, "topicType": string, "segments": string[]}。',
      `- segments 数量 1-${preferredSegments}，短句，像真人分几句说。`,
      '- 不要项目符号、编号列表或 markdown。',
      '- 不要 emoji，不要自我介绍。',
      `- 如果 shouldSpeak=true，优先输出 ${preferredSegments} 句左右。`,
      '- 最后一段可以是引导问题，方便用户顺着追问。'
    ].join('\n')

    try {
      const raw = await createChatCompletion(
        {
          systemPrompt: [
            identityPrompt,
            '你负责生成主动消息。要像自然冒泡，不要像项目经理催进度。',
            '严格输出 JSON，不要 markdown。'
          ].join('\n'),
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.75
        },
        settings
      )

      // 解析 JSON
      const parsed = JSON.parse(raw)
      if (parsed.shouldSpeak && Array.isArray(parsed.segments) && parsed.segments.length > 0) {
        return {
          shouldSpeak: true,
          topicType: parsed.topicType ?? topicType,
          segments: parsed.segments.map((s: string) => clip(s, 90)).filter(Boolean).slice(0, 6),
          reason: 'generated'
        }
      }
    } catch (error) {
      logger.warn('dialog', 'Proactive message generation failed', { error: String(error) })
    }

    return { shouldSpeak: false, topicType, segments: [], reason: 'generation_failed' }
  }

  /**
   * 构建多模态输出（文字+图片+语音）
   */
  buildMultimodalOutput(text: string, image?: { url?: string; base64?: string }, audio?: { url?: string; base64?: string }): MultimodalOutput {
    return {
      text,
      image: image ? { url: image.url, base64: image.base64 } : undefined,
      audio: audio ? { url: audio.url, base64: audio.base64 } : undefined
    }
  }
}

export const dialogEngine = new DialogEngine()
