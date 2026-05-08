import type { BrowserWindow } from 'electron'
import type { AppRepository } from '@main/repositories/database'
import type { SegmentEventPayload, TopicType, TypingEventPayload } from '@shared/types'
import { logger } from '@main/services/logger'

interface OutputInput {
  mainWindow: BrowserWindow
  repository: AppRepository
  messageId: number
  sessionId: string
  topicType: TopicType | null
  segments: string[]
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function computeSegmentDelay(segment: string, index: number, total: number): number {
  const charCount = segment.length
  const basePerChar = 35 + Math.random() * 25
  const typingTime = Math.min(charCount * basePerChar, 2800)
  const variance = (Math.random() - 0.5) * 400
  const thinkingPause = Math.random() < 0.15 ? 800 + Math.random() * 1200 : 0
  const firstSegmentBonus = index === 0 ? 200 + Math.random() * 400 : 0
  return Math.max(300, Math.round(typingTime + variance + thinkingPause + firstSegmentBonus))
}

export class SegmentedMessageService {
  private activeMessageId: number | null = null
  private interrupted = false

  interrupt(): void {
    this.interrupted = true
  }

  private emitTypingState(mainWindow: BrowserWindow, sessionId: string, messageId: number, state: TypingEventPayload['state']): void {
    const payload: TypingEventPayload = { sessionId, messageId, state }
    mainWindow.webContents.send('assistant:typing', payload)
  }

  async output(input: OutputInput): Promise<{ interrupted: boolean; emittedCount: number; totalSegments: number }> {
    logger.info('segments', 'Starting segmented output.', {
      messageId: input.messageId,
      sessionId: input.sessionId,
      topicType: input.topicType,
      segmentCount: input.segments.length
    })
    this.activeMessageId = input.messageId
    this.interrupted = false
    const emittedSegments: string[] = []

    this.emitTypingState(input.mainWindow, input.sessionId, input.messageId, 'reading')
    await wait(400 + Math.random() * 600)

    for (let index = 0; index < input.segments.length; index += 1) {
      if (this.interrupted) {
        logger.warn('segments', 'Segmented output interrupted before next segment.', {
          messageId: input.messageId,
          emittedCount: emittedSegments.length
        })
        break
      }

      this.emitTypingState(input.mainWindow, input.sessionId, input.messageId, 'typing')

      const segment = input.segments[index]
      const delay = computeSegmentDelay(segment, index, input.segments.length)
      await wait(delay)

      if (this.interrupted) break

      emittedSegments.push(segment)
      await input.repository.updateMessageSegments(input.messageId, emittedSegments)
      const payload: SegmentEventPayload = {
        messageId: input.messageId,
        sessionId: input.sessionId,
        segment,
        segmentIndex: index,
        totalSegments: input.segments.length,
        topicType: input.topicType,
        isFinal: index === input.segments.length - 1
      }
      input.mainWindow.webContents.send('assistant:segment', payload)
      logger.info('segments', 'Segment emitted.', {
        messageId: input.messageId,
        segmentIndex: index,
        totalSegments: input.segments.length
      })
    }

    await input.repository.updateMessageSegments(input.messageId, emittedSegments)
    this.emitTypingState(input.mainWindow, input.sessionId, input.messageId, 'idle')
    this.activeMessageId = null
    const interrupted = this.interrupted
    this.interrupted = false
    logger.info('segments', 'Segmented output finished.', {
      messageId: input.messageId,
      interrupted,
      emittedCount: emittedSegments.length
    })
    return { interrupted, emittedCount: emittedSegments.length, totalSegments: input.segments.length }
  }
}
