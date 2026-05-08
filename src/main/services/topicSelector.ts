import type { MemoryRecord, TopicSelection, TopicType } from '@shared/types'
import type { ProactiveContext } from '@main/types/runtime'
import { getRecentConversationText, isProjectLike, isCasualTopic } from './proactiveHelpers'

const TOPIC_ORDER: TopicType[] = ['greeting', 'project_reminder', 'task_push', 'simple_review', 'casual_chat']

function findLatestProactiveSummary(memories: MemoryRecord[]): MemoryRecord | null {
  return (
    memories
      .filter((memory) => memory.type === 'proactive_summary')
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0] ?? null
  )
}

function hasOpenTask(memories: MemoryRecord[]): boolean {
  return memories.some((memory) => memory.type === 'task' && (memory.metadata?.taskStatus ?? 'open') === 'open')
}

function hasSoonTask(memories: MemoryRecord[]): boolean {
  const now = Date.now()
  return memories.some((memory) => {
    if (memory.type !== 'task' || (memory.metadata?.taskStatus ?? 'open') !== 'open') return false
    const deadline = memory.metadata?.deadline
    if (!deadline) return false
    const diffHours = (new Date(deadline).getTime() - now) / (60 * 60 * 1000)
    return diffHours <= 48
  })
}

export async function selectTopic(
  context: ProactiveContext,
  topicWeights: Record<TopicType, number>
): Promise<TopicSelection> {
  const lastTopic = context.runtimeState.lastTopicType
  const recentText = context.recentMessages
    .map((message) => (message.segments.length > 0 ? message.segments.join(' ') : message.content))
    .join('\n')
  const latestProactiveSummary = findLatestProactiveSummary(context.memories)
  const dayPart = context.runtimeState.environment.dayPart
  const emotion = context.runtimeState.emotionState
  const recentConversationText = getRecentConversationText(context.recentMessages)
  const recentIsCasual = isCasualTopic(recentConversationText) && !isProjectLike(recentConversationText)
  const hasProjectMemory = context.memories.some(
    (memory) => memory.type === 'project_fact' || memory.type === 'project_goal'
  )

  // Humanization: desireToTalk acts as an "impulse" override.
  // When desire is very low, only speak if there's a genuinely strong reason.
  // When desire is very high, be more willing to just say something casual.
  const desire = context.runtimeState.desireToTalk

  if (latestProactiveSummary && !recentIsCasual) {
    const ageHours = (Date.now() - new Date(latestProactiveSummary.updatedAt).getTime()) / (60 * 60 * 1000)
    const previousTopic = latestProactiveSummary.metadata?.topicType
    if (ageHours <= 48 && previousTopic && previousTopic !== 'greeting') {
      return {
        topicType: previousTopic,
        reason: '上次主动消息还有后续空间，先沿着同一条主线继续。'
      }
    }
  }

  // Low desire: only break silence for genuinely urgent matters.
  if (desire < 22) {
    if (hasSoonTask(context.memories)) {
      return {
        topicType: 'task_push',
        reason: '欲望极低，但存在紧迫任务，强迫自己说一句。'
      }
    }
    // Don't speak at all for low-priority topics.
    return {
      topicType: 'simple_review',
      reason: `欲望值 ${desire} 极低，改成最轻量的复盘，不主动推动。`
    }
  }

  // High desire: be more casual, more willing to just say hi or casual chat.
  if (desire >= 80) {
    if (recentIsCasual) {
      return {
        topicType: 'greeting',
        reason: `欲望值 ${desire} 很高，最近在闲聊，直接接住话题随便说点。`
      }
    }
    if (dayPart === 'evening' || dayPart === 'late_night') {
      return {
        topicType: 'simple_review',
        reason: `欲望值 ${desire} 很高，选择轻松的晚间复盘形式。`
      }
    }
  }

  if (emotion === 'drained' || emotion === 'concerned') {
    return {
      topicType: dayPart === 'evening' || dayPart === 'late_night' ? 'simple_review' : 'greeting',
      reason: '当前情绪状态偏低，降低推进压力，选择更轻的问候或复盘。'
    }
  }

  if (hasSoonTask(context.memories)) {
    if (dayPart === 'late_night') {
      return {
        topicType: 'simple_review',
        reason: '当前已经是深夜，先不推任务，改成轻量复盘更合适。'
      }
    }
    return {
      topicType: 'task_push',
      reason: '存在即将到期或已经到期的任务，优先做任务推进。'
    }
  }

  if (context.runtimeState.userState === 'returned') {
    return {
      topicType: lastTopic === 'greeting' ? 'project_reminder' : 'greeting',
      reason: '用户刚回到桌面，先用轻问候重新接住对话。'
    }
  }

  if (
    context.settings.enableEnvironmentAwareness &&
    dayPart === 'evening' &&
    context.runtimeState.intimacyScore >= 52 &&
    lastTopic !== 'simple_review'
  ) {
    return {
      topicType: 'simple_review',
      reason: '当前是晚上，且关系熟悉度足够，适合做轻量复盘。'
    }
  }

  if (hasOpenTask(context.memories) && lastTopic !== 'task_push') {
    if (dayPart === 'late_night') {
      return {
        topicType: 'project_reminder',
        reason: '深夜不适合继续推任务，改成轻一点的项目提醒。'
      }
    }
    return {
      topicType: 'task_push',
      reason: '当前存在未完成任务，适合优先做进度推进。'
    }
  }

  if (hasProjectMemory) {
    if (recentIsCasual) {
      return {
        topicType: 'greeting',
        reason: '最近对话在闲聊主题上，先不强行切回项目推进。'
      }
    }
    const projectTopic = topicWeights.task_push > topicWeights.project_reminder ? 'task_push' : 'project_reminder'
    if (projectTopic !== lastTopic) {
      return {
        topicType: projectTopic,
        reason: '项目相关记忆较强，优先围绕当前项目推进。'
      }
    }
  }

  if (/系统设计|架构|模块|策略|记忆|测试|评分|自检/.test(recentText) && lastTopic !== 'simple_review') {
    return {
      topicType: 'simple_review',
      reason: '最近在讨论方案和结构，适合做简短复盘。'
    }
  }

  if (context.runtimeState.motivationScore >= 68 && lastTopic !== 'project_reminder') {
    return {
      topicType: 'project_reminder',
      reason: '当前动机较强，适合给一个克制的项目推进提醒。'
    }
  }

  return {
    topicType: TOPIC_ORDER
      .filter((topic) => topic !== lastTopic)
      .sort((left, right) => topicWeights[right] - topicWeights[left])[0],
    reason: '基于状态、偏好权重和避免重复原则选择了当前话题。'
  }
}
