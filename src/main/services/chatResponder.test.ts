import { describe, it, expect } from 'vitest'
import { sanitizeAssistantReply } from './chatResponder'
import type { MessageRecord } from '@shared/types'

function makeMessages(contents: string[]): MessageRecord[] {
  return contents.map((content, i) => ({
    id: i + 1,
    sessionId: 'test',
    role: (i % 2 === 0 ? 'user' : 'assistant') as MessageRecord['role'],
    content,
    segments: [content],
    topicType: null,
    isProactive: false,
    createdAt: new Date().toISOString()
  }))
}

describe('sanitizeAssistantReply', () => {
  it('returns default fallback for empty text', () => {
    const result = sanitizeAssistantReply('', [])
    expect(result).toBe('我在。你直接说就行。')
  })

  it('strips markdown bold formatting', () => {
    const result = sanitizeAssistantReply('这是 **重点** 内容', [])
    expect(result).toContain('这是 重点 内容')
  })

  it('strips emoji characters', () => {
    const result = sanitizeAssistantReply('你好😊今天开心吗🎉', [])
    expect(result).not.toContain('😊')
    expect(result).not.toContain('🎉')
    expect(result).toContain('你好')
  })

  it('removes internal context leak markers', () => {
    const result = sanitizeAssistantReply('上一轮用户重点关注了某件事\n正常回复内容', [])
    expect(result).not.toContain('上一轮用户重点')
    expect(result).toContain('正常回复内容')
  })

  it('detects false duplicate claims and corrects them', () => {
    const result = sanitizeAssistantReply('你怎么连发两条消息了', makeMessages(['你好', '回复']))
    expect(result).toContain('我这边别乱下结论')
  })

  it('allows duplicate claim when messages actually repeat', () => {
    const messages = makeMessages(['你好', '回复', '你好'])
    const result = sanitizeAssistantReply('你怎么连发两条了', messages)
    expect(result).toContain('连发两条')
  })

  it('removes code backtick formatting', () => {
    const result = sanitizeAssistantReply('使用 `console.log` 来调试', [])
    expect(result).not.toContain('`')
    expect(result).toContain('使用 console.log 来调试')
  })

  it('removes markdown link syntax', () => {
    const result = sanitizeAssistantReply('点击[这里](https://example.com)查看', [])
    expect(result).not.toContain('[')
    expect(result).toContain('点击这里查看')
  })
})
