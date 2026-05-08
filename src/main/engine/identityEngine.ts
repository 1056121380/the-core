// ============================================================
// IdentityEngine - 数字人身份引擎
// 负责加载、管理、切换人设配置
// 支持 JSON 驱动的热插拔人设
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import type {
  IdentityProfile,
  IdentitySummary,
  PersonalityTrait,
  SpeakingStyle,
  VoiceConfig
} from '@main/types/digitalHuman'
import { DEFAULT_SETTINGS } from '@shared/constants'

const DEFAULT_IDENTITY_PATH = path.join(process.cwd(), 'src', 'main', 'config', 'identity.example.json')

export class IdentityEngine {
  private profile: IdentityProfile | null = null
  private loadedPath: string | null = null

  /**
   * 从 JSON 文件加载身份配置
   */
  loadFromFile(filePath?: string): IdentityProfile {
    const targetPath = filePath ?? DEFAULT_IDENTITY_PATH
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Identity file not found: ${targetPath}`)
    }
    const raw = fs.readFileSync(targetPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<IdentityProfile>
    if (!parsed.name || !parsed.personality || !parsed.voice) {
      throw new Error('Invalid identity profile: missing required fields (name, personality, voice)')
    }
    this.profile = parsed as IdentityProfile
    this.loadedPath = targetPath
    return this.profile
  }

  /**
   * 直接设置身份配置（用于测试、动态创建）
   */
  setProfile(profile: IdentityProfile): void {
    this.profile = profile
    this.loadedPath = null
  }

  /**
   * 获取当前身份配置
   */
  getProfile(): IdentityProfile {
    if (!this.profile) {
      this.profile = this.loadFromFile()
    }
    return this.profile
  }

  /**
   * 是否已加载
   */
  isLoaded(): boolean {
    return this.profile !== null
  }

  /**
   * 获取已加载文件的路径
   */
  getLoadedPath(): string | null {
    return this.loadedPath
  }

  /**
   * 获取一句话描述
   */
  getSummary(): IdentitySummary {
    const profile = this.getProfile()
    const mainTraits = profile.personality.traits
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((t) => t.trait)
      .join('、')

    return {
      name: profile.name,
      shortDesc: `${profile.name}是一个${mainTraits}的女生。`,
      personality: profile.personality.rules.slice(0, 2).join('，')
    }
  }

  /**
   * 获取主要性格特征（按权重排序）
   */
  getMainTraits(): PersonalityTrait[] {
    return this.getProfile().personality.traits.sort((a, b) => b.weight - a.weight)
  }

  /**
   * 获取说话风格规则
   */
  getSpeakingStyle(): SpeakingStyle {
    const { rules, forbidden, examples } = this.getProfile().personality
    return { rules, forbidden, examples }
  }

  /**
   * 获取语音配置
   */
  getVoiceConfig(): VoiceConfig {
    return this.getProfile().voice
  }

  /**
   * 获取背景故事
   */
  getBackstory(): string {
    return this.getProfile().backstory
  }

  /**
   * 构建对话系统的 systemPrompt
   */
  buildSystemPrompt(settings?: Partial<Pick<typeof DEFAULT_SETTINGS, 'identityProfile' | 'personaPrompt' | 'habitProfile'>>): string {
    const profile = this.getProfile()
    const traits = profile.personality.traits.sort((a, b) => b.weight - a.weight).slice(0, 3).map((t) => t.trait).join('、')

    const segments: string[] = [
      `身份事实：${profile.name}，${profile.age ?? ''}，${profile.constellation ? `星座${profile.constellation}` : ''}。性格特点：${traits}。`,
      `背景故事：${profile.backstory}`,
      `说话风格：${profile.personality.rules.join('。')}`,
      `禁止：${profile.personality.forbidden.join('。')}`
    ]

    if (settings?.identityProfile) {
      segments.unshift(settings.identityProfile)
    }
    if (settings?.personaPrompt) {
      segments.push(`补充人设：${settings.personaPrompt}`)
    }
    if (settings?.habitProfile) {
      segments.push(`用户偏好：${settings.habitProfile}`)
    }

    return segments.join('\n\n')
  }

  /**
   * 验证身份配置是否有效
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = []
    if (!this.profile) {
      errors.push('Identity profile not loaded')
      return { valid: false, errors }
    }

    if (!this.profile.name) errors.push('Missing name')
    if (!this.profile.personality?.traits?.length) errors.push('Missing personality traits')
    if (!this.profile.personality?.rules?.length) errors.push('Missing speaking rules')
    if (!this.profile.voice?.gender) errors.push('Missing voice config')

    return { valid: errors.length === 0, errors }
  }
}

// 单例，全局共享
export const identityEngine = new IdentityEngine()
