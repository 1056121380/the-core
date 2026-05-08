import type { FeedbackContext, FeedbackType, TopicType } from '@shared/types'
import type { AppRepository } from '@main/repositories/database'
import { logger } from '@main/services/logger'

interface FeedbackLearningInput {
  sessionId: string
  messageId: number
  feedbackType: FeedbackType
  topicType: TopicType | null
  context?: FeedbackContext | null
}

function describeContext(context?: FeedbackContext | null): string {
  if (!context) return '未附带消息上下文。'
  return `样本：${context.segmentCount} 段，${context.contentLength} 字，发送时段 ${context.sentHour} 点。`
}

export async function applyFeedbackLearning(
  repository: AppRepository,
  input: FeedbackLearningInput
): Promise<string> {
  logger.info('feedback', 'Applying user feedback.', {
    sessionId: input.sessionId,
    messageId: input.messageId,
    feedbackType: input.feedbackType,
    topicType: input.topicType
  })

  await repository.applyFeedback(input)

  if (input.feedbackType === 'negative') {
    return '用户选择了“别打扰”，已进入 cooldown，并下调当前话题的主动性。'
  }

  const contextSummary = describeContext(input.context)
  if (input.feedbackType === 'positive') {
    return input.topicType
      ? `用户认为 ${input.topicType} 这类主动消息有用，已轻微提高话题权重，并记录偏好的段数、长度和时段。${contextSummary}`
      : `用户认为这条主动消息有用，已记录偏好的段数、长度和时段。${contextSummary}`
  }

  return input.topicType
    ? `用户认为 ${input.topicType} 这类主动消息一般，已轻微降低话题权重，并保留偏好样本。${contextSummary}`
    : `用户认为这条主动消息一般，已保留偏好样本。${contextSummary}`
}
