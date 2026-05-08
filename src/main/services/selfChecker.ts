import { SelfCheckResponseSchema } from '@shared/schema'
import type {
  EmotionState,
  EnvironmentSnapshot,
  MemoryRecord,
  MessageRecord,
  SelfCheckResult,
  SettingsRecord,
  TopicType,
  UserState
} from '@shared/types'
import { clamp } from '@shared/utils'
import { createChatCompletion } from '@main/services/llmClient'

interface SelfCheckInput {
  candidateSegments: string[]
  userState: UserState
  environment: EnvironmentSnapshot
  emotionState: EmotionState
  personaPrompt: string
  recentMessages: MessageRecord[]
  selectedMemories: MemoryRecord[]
  topicType: TopicType
  maxSegments: number
  mockMode: boolean
  settings: SettingsRecord
  intimacyScore?: number
}

const BLOCKED_PHRASES = ['你怎么又', '必须马上', '再不做就', '立刻去做', '赶紧给我']
const UNSUPPORTED_RELATIVE_TIME = /(昨天|上周|前几天|前阵子|刚才|上个月|去年)/
const COLD_REPLY_PATTERNS = /(不难记|习惯了简洁|随口说的|实际叫什么你更清楚|你那边有具体的聊天记录吗)/

function isTooSimilar(left: string[], right: string[]): boolean {
  const normalizedLeft = left.join(' ').replace(/\s+/g, '')
  const normalizedRight = right.join(' ').replace(/\s+/g, '')
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      (normalizedLeft === normalizedRight ||
        normalizedLeft.includes(normalizedRight) ||
        normalizedRight.includes(normalizedLeft))
  )
}

function softenSegments(segments: string[], maxSegments: number): string[] {
  return segments
    .map((segment) =>
      segment
        .replace(/你怎么又/g, '我注意到')
        .replace(/必须马上/g, '可以先')
        .replace(/再不做就/g, '如果继续拖着')
        .replace(/立刻去做/g, '先推进一点')
        .replace(/赶紧给我/g, '你可以先')
        .trim()
    )
    .filter(Boolean)
    .slice(0, maxSegments)
}

function fallbackSelfCheck(input: SelfCheckInput): SelfCheckResult {
  const joined = input.candidateSegments.join(' ')
  if (UNSUPPORTED_RELATIVE_TIME.test(joined)) {
    return {
      pass: false,
      score: 20,
      reason: '主动消息包含没有明确依据的相对时间词。',
      risk: ['unsupported_relative_time'],
      rewriteSegments: input.candidateSegments
        .map((segment) => segment.replace(/昨天|上周|前几天|前阵子|刚才|上个月|去年/g, '之前').trim())
        .filter(Boolean)
        .slice(0, input.maxSegments)
    }
  }
  if (COLD_REPLY_PATTERNS.test(joined)) {
    return {
      pass: false,
      score: 22,
      reason: '语气偏冷或像在推卸，不像自然聊天。',
      risk: ['cold_tone'],
      rewriteSegments: input.candidateSegments
        .map((segment) =>
          segment
            .replace(/不难记/g, '我会记着这个偏好')
            .replace(/习惯了简洁/g, '我会说得更自然一点')
            .replace(/随口说的/g, '这个说法不严谨')
            .trim()
        )
        .filter(Boolean)
        .slice(0, input.maxSegments)
    }
  }
  if (input.candidateSegments.length > input.maxSegments) {
    return {
      pass: false,
      score: 30,
      reason: 'LLM 自检不可用，段数超过上限。',
      risk: ['too_many_segments'],
      rewriteSegments: input.candidateSegments.slice(0, input.maxSegments)
    }
  }
  if (BLOCKED_PHRASES.some((phrase) => input.candidateSegments.join(' ').includes(phrase))) {
    return {
      pass: false,
      score: 12,
      reason: 'LLM 自检不可用，内容包含过度打扰表达。',
      risk: ['disturbing_tone'],
      rewriteSegments: softenSegments(input.candidateSegments, input.maxSegments)
    }
  }
  return {
    pass: true,
    score: 65,
    reason: 'LLM 自检不可用，已通过基础规则检查。',
    risk: [],
    rewriteSegments: input.candidateSegments
  }
}

async function runLlmSelfCheck(input: SelfCheckInput): Promise<SelfCheckResult> {
  const candidateText = input.candidateSegments.join('\n')
  const recentText = input.recentMessages
    .slice(-6)
    .map((m) => `${m.role}: ${(m.segments.length > 0 ? m.segments.join(' ') : m.content).slice(0, 100)}`)
    .join('\n')
  const memoryText = input.selectedMemories
    .slice(0, 5)
    .map((m) => `- ${m.content}`)
    .join('\n')

  const prompt = [
    '你是主动消息自检器。请评估以下待发送的主动消息。',
    '',
    `话题类型：${input.topicType}`,
    `用户状态：${input.userState}`,
    `情绪状态：${input.emotionState}`,
    `当前时段：${input.environment.dayPart}`,
    `安静时段：${input.environment.isQuietHours ? '是' : '否'}`,
    '',
    '待发送消息：',
    candidateText,
    '',
    '最近对话：',
    recentText || '(无)',
    '',
    '相关记忆：',
    memoryText || '(无)',
    '',
    '评估标准：',
    '1. 语气是否克制、不打扰。',
    '2. 是否与当前上下文相关。',
    '3. 段数是否合适。',
    '4. 是否存在催促、说教、过度热情等问题。',
    '5. 情绪状态是否匹配，疲惫时不应继续催促。',
    '6. 没有明确时间依据时，是否错误使用了“昨天、上周、前几天、刚才”等相对时间。',
    '7. 是否语气冷淡、推卸、像在顶嘴。',
    '8. 如果不通过，请给出 rewriteSegments，尽量保留原意但降低打扰感。',
    '',
    '只输出 JSON：{"pass": boolean, "score": 0-100, "reason": "简短说明", "risk": ["风险标签"], "rewriteSegments": ["可选改写"]}。'
  ].join('\n')

  try {
    const raw = await createChatCompletion(
      {
        systemPrompt: '你是严格的主动消息质量检查器。只输出 JSON，不要解释。',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      },
      input.settings
    )

    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      return fallbackSelfCheck(input)
    }

    const parsed = SelfCheckResponseSchema.safeParse(JSON.parse(match[0]))
    if (!parsed.success) {
      return fallbackSelfCheck(input)
    }

    const result = parsed.data
    const rewrite = (result.rewriteSegments ?? []).filter((s) => s.trim().length > 0).slice(0, input.maxSegments)

    return {
      pass: result.pass,
      score: clamp(result.score, 0, 100),
      reason: result.reason || 'LLM 自检完成。',
      risk: result.risk ?? [],
      rewriteSegments: rewrite.length > 0 ? rewrite : input.candidateSegments
    }
  } catch {
    return fallbackSelfCheck(input)
  }
}

export async function runSelfCheck(input: SelfCheckInput): Promise<SelfCheckResult> {
  const staticCheck = fallbackSelfCheck(input)
  if (!staticCheck.pass) {
    return staticCheck
  }

  if (!input.mockMode) {
    return runLlmSelfCheck(input)
  }

  if (input.topicType === 'greeting') {
    return {
      pass: true,
      score: 88,
      reason: '问候类内容可以跳过复杂自检。',
      risk: [],
      rewriteSegments: input.candidateSegments
    }
  }

  if (input.candidateSegments.length > input.maxSegments) {
    return {
      pass: false,
      score: 30,
      reason: 'segments 数量超过上限。',
      risk: ['too_many_segments'],
      rewriteSegments: input.candidateSegments.slice(0, input.maxSegments)
    }
  }

  if (BLOCKED_PHRASES.some((phrase) => input.candidateSegments.join(' ').includes(phrase))) {
    return {
      pass: false,
      score: 12,
      reason: '内容包含过度打扰表达。',
      risk: ['disturbing_tone'],
      rewriteSegments: softenSegments(input.candidateSegments, input.maxSegments)
    }
  }

  if (input.environment.isQuietHours && input.candidateSegments.length >= 4) {
    return {
      pass: false,
      score: 36,
      reason: '当前处于安静时段，这条主动消息偏长。',
      risk: ['quiet_hours_too_long'],
      rewriteSegments: input.candidateSegments.slice(0, 2)
    }
  }

  const lastProactive = [...input.recentMessages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.isProactive)
  if (lastProactive && isTooSimilar(input.candidateSegments, lastProactive.segments)) {
    return {
      pass: false,
      score: 24,
      reason: '与最近一条主动消息过于相似。',
      risk: ['duplicate'],
      rewriteSegments: []
    }
  }

  if (input.userState === 'active' && input.candidateSegments.length >= (input.intimacyScore && input.intimacyScore >= 50 ? 6 : 5)) {
    return {
      pass: false,
      score: 40,
      reason: '用户还比较活跃，这条主动消息偏长，容易打断当前节奏。',
      risk: ['too_long_for_active_state'],
      rewriteSegments: input.candidateSegments.slice(0, 3)
    }
  }

  if (input.emotionState === 'drained' && /快点|马上|立刻/.test(input.candidateSegments.join(' '))) {
    return {
      pass: false,
      score: 28,
      reason: '当前情绪较疲惫，语气不应继续催促。',
      risk: ['emotion_mismatch'],
      rewriteSegments: softenSegments(input.candidateSegments, input.maxSegments)
    }
  }

  const selectedMemoryText = input.selectedMemories.map((memory) => memory.content).join(' ')
  const lengthLimit = input.intimacyScore && input.intimacyScore >= 55 ? 260 : 200
  if (selectedMemoryText && !input.personaPrompt.includes('克制') && input.candidateSegments.join(' ').length > lengthLimit) {
    return {
      pass: false,
      score: 42,
      reason: '输出过长，已经偏离克制短句的人设边界。',
      risk: ['persona_mismatch'],
      rewriteSegments: input.candidateSegments.slice(0, 4)
    }
  }

  return {
    pass: true,
    score: input.userState === 'active' && input.candidateSegments.length >= 3 ? 78 : 86,
    reason: '内容和当前项目相关，语气克制，不突兀。',
    risk: [],
    rewriteSegments: input.candidateSegments
  }
}
