import type { DayPart, MemoryLayer, MemoryRecord, MemoryType, SettingsRecord } from './types'

export const DEFAULT_SETTINGS: SettingsRecord = {
  threshold: 70,
  dailyLimit: 3,
  cooldownHoursAfterReject: 8,
  maxSegments: 6,
  checkIntervalMinutes: 5,
  minMinutesBetweenProactive: 60,
  activeConversationBlockMinutes: 2,
  proactiveRandomness: 0.35,
  proactiveDesireBias: 0,
  memoryAutoStoreEnabled: true,
  memoryImportanceThreshold: 0.72,
  enableLlmSelfCheck: true,
  mockMode: false,
  llmEnabled: true,
  llmApiKey: '',
  llmBaseUrl: 'https://api.minimaxi.com/anthropic',
  llmModel: 'MiniMax-M2.7',
  identityProfile:
    '你是一个活泼、自然、有一点俏皮感的女生型桌面聊天助手。你可以轻松陪聊，也能帮用户推进项目，但不要装真人、不要编造自己看过现实文件或现实经历。',
  personaPrompt:
    '你说话要像一个真实的人：自然、温暖、有回应感，可以稍微俏皮，但不要油腻、不要客服腔、不要自我介绍式废话。用户闲聊时就自然闲聊；用户聊项目时再贴着项目推进。默认用 1 到 6 个自然短句表达，不要列表汇报，不要把系统分析过程说出来。',
  habitProfile:
    '用户不喜欢冷漠、过度简洁、客服腔和空话。用户希望助手更有温度、更像人，但不要夸张热情。用户也在意项目推进效率、输出可调试性和可维护性。',
  assistantTimezone: 'Asia/Hong_Kong',
  assistantLocation: 'Hong Kong',
  weatherSummary: '室内工作场景，默认不主动引用天气，除非用户手动配置了明确天气。',
  quietHoursStart: 0,
  quietHoursEnd: 8,
  enableEnvironmentAwareness: true,
  enableEmotionModel: true,
  enableMotivationModel: true,
  enableRelationshipModel: true,
  verbalTics: ['嗯…', '话说，', '对了，'],
  logLevel: 'info'
}

export const DEFAULT_PERSONA = DEFAULT_SETTINGS.personaPrompt

export const DEFAULT_MEMORIES: Array<Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>> = [
  {
    type: 'project_fact',
    content: '当前项目是一个纯文本主动聊天桌面助手 MVP。',
    weight: 0.96,
    isPinned: false,
    sessionId: null,
    source: 'system_seed',
    metadata: { memoryLayer: 'long_term', importanceReason: '项目主线' }
  },
  {
    type: 'project_goal',
    content: '第一版重点验证主动触发、冷却、记忆和文本分段输出，不接 ASR、TTS 和摄像头。',
    weight: 0.95,
    isPinned: false,
    sessionId: null,
    source: 'system_seed',
    metadata: { memoryLayer: 'long_term', importanceReason: '阶段目标' }
  },
  {
    type: 'user_preference',
    content: '用户不喜欢过度废话、过度热情和客服腔。',
    weight: 0.92,
    isPinned: false,
    sessionId: null,
    source: 'system_seed',
    metadata: { memoryLayer: 'persona', importanceReason: '稳定偏好' }
  },
  {
    type: 'user_preference',
    content: '用户希望助手像人一样把话分成几句说。',
    weight: 0.91,
    isPinned: false,
    sessionId: null,
    source: 'system_seed',
    metadata: { memoryLayer: 'persona', importanceReason: '输出风格偏好' }
  },
  {
    type: 'style_rule',
    content: '默认回答要自然、温暖、有回应感，不要冷漠，也不要把内部分析过程说给用户。',
    weight: 0.94,
    isPinned: false,
    sessionId: null,
    source: 'system_seed',
    metadata: { memoryLayer: 'persona', importanceReason: '人设规则' }
  },
  {
    type: 'style_rule',
    content: '主动聊天不要太频繁，被拒绝后要冷却。',
    weight: 0.9,
    isPinned: false,
    sessionId: null,
    source: 'system_seed',
    metadata: { memoryLayer: 'persona', importanceReason: '打扰边界' }
  }
]

export function getMemoryLayer(type: MemoryType): MemoryLayer {
  switch (type) {
    case 'recent_summary':
    case 'proactive_summary':
      return 'short_term'
    case 'user_fact':
    case 'user_preference':
    case 'style_rule':
      return 'persona'
    case 'project_fact':
    case 'project_goal':
    case 'task':
    default:
      return 'long_term'
  }
}

export function getDayPart(hour: number): DayPart {
  if (hour < 6) {
    return 'late_night'
  }
  if (hour < 12) {
    return 'morning'
  }
  if (hour < 18) {
    return 'afternoon'
  }
  return 'evening'
}
