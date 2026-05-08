export type Role = 'user' | 'assistant' | 'system'
export type UserState = 'idle' | 'active' | 'away' | 'returned' | 'cooldown'
export type MemoryLayer = 'short_term' | 'persona' | 'long_term'
export type EmotionState = 'steady' | 'focused' | 'warm' | 'concerned' | 'drained'
export type DayPart = 'late_night' | 'morning' | 'afternoon' | 'evening'
export type MemoryType =
  | 'recent_summary'
  | 'proactive_summary'
  | 'project_fact'
  | 'project_goal'
  | 'user_fact'
  | 'user_preference'
  | 'style_rule'
  | 'task'
export type MemorySource =
  | 'manual'
  | 'system_seed'
  | 'chat_summary'
  | 'maintenance'
  | 'feedback_learning'
export type MemorySummaryMode = 'none' | 'heuristic' | 'llm'
export type FeedbackType = 'positive' | 'neutral' | 'negative'
export type TopicType = 'greeting' | 'project_reminder' | 'task_push' | 'simple_review' | 'casual_chat'
export type ProactiveDecision = 'blocked' | 'silent' | 'speak'
export type TaskStatus = 'open' | 'done' | 'archived'
export type LogLevel = 'info' | 'warn' | 'error'

export interface EnvironmentSnapshot {
  timezone: string
  locationLabel: string
  weatherSummary: string
  localHour: number
  dayPart: DayPart
  isQuietHours: boolean
}

export interface MemoryMetadata {
  deadline?: string | null
  taskStatus?: TaskStatus
  topicType?: TopicType | null
  sentAt?: string | null
  followUpHint?: string | null
  activeHourHistogram?: number[]
  preferredHourHistogram?: number[]
  preferredSegmentCount?: number | null
  preferredContentLength?: number | null
  importanceReason?: string | null
  sourceMessageIds?: number[]
  confidence?: number | null
  hitCount?: number
  lastHitAt?: string | null
  lastHitStage?: 'chat' | 'proactive' | null
  positiveFeedbackCount?: number
  neutralFeedbackCount?: number
  negativeFeedbackCount?: number
  memoryLayer?: MemoryLayer
  /**
   * Humanization: confidence 0-1, how sure the AI is about this memory.
   * Below 0.6 means uncertain/unreliable recall. Below 0.4 means "I'm not sure I remember correctly".
   */
  recallConfidence?: number | null
}

export interface MessageRecord {
  id: number
  sessionId: string
  role: Role
  content: string
  segments: string[]
  topicType: TopicType | null
  isProactive: boolean
  createdAt: string
}

export interface MemoryRecord {
  id: number
  type: MemoryType
  content: string
  weight: number
  isPinned: boolean
  sessionId: string | null
  source: MemorySource
  metadata?: MemoryMetadata | null
  createdAt: string
  updatedAt: string
}

export interface FeedbackContext {
  segmentCount: number
  contentLength: number
  sentHour: number
  sentAt: string
  minutesSinceLastInteraction: number | null
}

export interface FeedbackRecord {
  id: number
  messageId: number
  feedbackType: FeedbackType
  topicType: TopicType | null
  context?: FeedbackContext | null
  createdAt: string
}

export interface ScoreBreakdownItem {
  name: string
  value: number
}

export interface ProactiveEventRecord {
  id: number
  sessionId: string
  eventType: string
  score: number | null
  breakdown: ScoreBreakdownItem[]
  decision: ProactiveDecision
  reason: string
  createdAt: string
}

export interface RuntimeState {
  currentTime: string
  environment: EnvironmentSnapshot
  lastInteractionAt: string | null
  lastProactiveAt: string | null
  todayProactiveCount: number
  cooldownUntil: string | null
  recentlyRejected: boolean
  userState: UserState
  lastRejectedAt: string | null
  lastTopicType: TopicType | null
  activeHourHistogram: number[]
  preferredHourHistogram: number[]
  preferredSegmentCount: number | null
  preferredContentLength: number | null
  emotionState: EmotionState
  emotionIntensity: number
  motivationScore: number
  intimacyScore: number
  interactionCount: number
  /**
   * Humanization: how much the AI feels engaged vs bored in current conversation.
   * Depletes as conversation goes on, recovers with breaks.
   */
  conversationalEnergy: number
  /**
   * Humanization: how interested the AI is in the current topic (0-1).
   * High = eager to talk more, Low =敷衍/bored.
   */
  topicInterest: number
  /**
   * Humanization: how motivated the AI is to share / be proactive (0-1).
   * Separate from score-based assessment — this is desire/impulse.
   */
  desireToTalk: number
  /**
   * Humanization: awkwardness after long silence (0-100).
   * High = tentative/distant, decays with each exchange.
   */
  estrangementLevel: number
}

export interface SettingsRecord {
  threshold: number
  dailyLimit: number
  cooldownHoursAfterReject: number
  maxSegments: number
  checkIntervalMinutes: number
  minMinutesBetweenProactive: number
  activeConversationBlockMinutes: number
  proactiveRandomness: number
  proactiveDesireBias: number
  memoryAutoStoreEnabled: boolean
  memoryImportanceThreshold: number
  enableLlmSelfCheck: boolean
  mockMode: boolean
  llmEnabled: boolean
  llmApiKey: string
  llmBaseUrl: string
  llmModel: string
  identityProfile: string
  personaPrompt: string
  habitProfile: string
  assistantTimezone: string
  assistantLocation: string
  weatherSummary: string
  quietHoursStart: number
  quietHoursEnd: number
  enableEnvironmentAwareness: boolean
  enableEmotionModel: boolean
  enableMotivationModel: boolean
  enableRelationshipModel: boolean
  verbalTics: string[]
  logLevel: LogLevel
}

export interface ScoreResult {
  score: number
  breakdown: ScoreBreakdownItem[]
}

export interface TopicSelection {
  topicType: TopicType
  reason: string
}

export interface CandidateMessage {
  shouldSpeak: boolean
  topicType: TopicType
  segments: string[]
}

export interface SelfCheckResult {
  pass: boolean
  score: number
  reason: string
  risk: string[]
  rewriteSegments: string[]
}

export interface AppSnapshot {
  sessionId: string
  messages: MessageRecord[]
  memories: MemoryRecord[]
  feedback: FeedbackRecord[]
  settings: SettingsRecord
  runtimeState: RuntimeState
  latestEvent: ProactiveEventRecord | null
  memoryDebug: MemoryDebugState
}

export interface SelectedMemoryDebugItem {
  memoryId: number
  type: MemoryType
  layer: MemoryLayer
  content: string
  weight: number
  isPinned: boolean
  score: number
  sessionId: string | null
  source: MemorySource
  confidence?: number | null
  hitCount?: number
  lastHitAt?: string | null
}

export interface MemoryDebugState {
  latestSelectionStage: 'chat' | 'proactive' | null
  latestSelectionQuery: string
  latestSelectionAt: string | null
  selectedMemories: SelectedMemoryDebugItem[]
  latestSummaryMode: MemorySummaryMode
  latestSummaryContent: string | null
  latestSummaryAt: string | null
}

export interface SegmentEventPayload {
  messageId: number
  sessionId: string
  segment: string
  segmentIndex: number
  totalSegments: number
  topicType: TopicType | null
  isFinal: boolean
}

export interface TypingEventPayload {
  sessionId: string
  messageId: number
  state: 'reading' | 'typing' | 'idle'
}

export interface DebugLogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
  meta?: Record<string, unknown>
}

export interface AutoTestCaseResult {
  id: string
  name: string
  status: 'passed' | 'failed' | 'warning'
  summary: string
  details: string[]
  metrics?: Record<string, string | number | boolean | null>
}

export interface AutoTestReport {
  sessionId: string
  startedAt: string
  finishedAt: string
  usedLiveLlm: boolean
  score: number
  summary: string
  cases: AutoTestCaseResult[]
  recommendations: string[]
}

export interface ChatExportResult {
  sessionId: string
  exportedAt: string
  jsonPath: string
  markdownPath: string
  messageCount: number
  proactiveEventCount: number
}
