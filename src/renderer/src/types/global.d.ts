import type { AssistantApi } from '../../../preload'

declare global {
  interface Window {
    assistantApi: AssistantApi
  }
}

export {}
