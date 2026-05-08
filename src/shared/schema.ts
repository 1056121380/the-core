import { z } from 'zod'

export const CandidateMessageSchema = z.object({
  shouldSpeak: z.boolean(),
  topicType: z.enum(['greeting', 'project_reminder', 'task_push', 'simple_review', 'casual_chat']),
  segments: z.array(z.string())
})

export const MemoryCandidateSchema = z.object({
  type: z.enum(['project_fact', 'project_goal', 'user_fact', 'user_preference', 'style_rule', 'task']),
  content: z.string().min(6),
  weight: z.number().min(0).max(1),
  shouldStore: z.boolean(),
  deadline: z.string().optional()
})

export const MemoryCandidateArraySchema = z.array(MemoryCandidateSchema)

export const AutoTestJudgeSchema = z.object({
  pass: z.boolean(),
  summary: z.string().optional(),
  details: z.array(z.string()).optional()
})

export const SelfCheckResponseSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(100),
  reason: z.string(),
  risk: z.array(z.string()),
  rewriteSegments: z.array(z.string()).optional()
})

export const OpenAiResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string()
      }).optional()
    })
  ).optional()
})

export const UserInputSchema = z.object({
  text: z.string().min(1, '消息不能为空').max(4000, '消息不能超过4000字').trim()
})

export const AnthropicResponseSchema = z.object({
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('thinking'), thinking: z.string() })
    ])
  ).optional()
})
