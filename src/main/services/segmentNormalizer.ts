function splitSentenceLine(line: string): string[] {
  const result: string[] = []
  let current = ''

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const prev = index > 0 ? line[index - 1] : ''
    const next = index + 1 < line.length ? line[index + 1] : ''

    current += char

    const isCnSentenceEnd = /[。！？；…]/.test(char)
    const isAsciiSentenceEnd = /[!?;]/.test(char)
    const isDotSentenceEnd = char === '.' && !/\d/.test(prev)
    const isListNumberMarker = /\d/.test(prev) && char === '.' && (next === ' ' || next === '\t')

    if ((isCnSentenceEnd || isAsciiSentenceEnd || isDotSentenceEnd) && !isListNumberMarker) {
      const trimmed = current.trim()
      if (trimmed) {
        result.push(trimmed)
      }
      current = ''
    }
  }

  const trailing = current.trim()
  if (trailing) {
    result.push(trailing)
  }

  return result
}

function stripListMarkers(text: string): string {
  return text
    .replace(/([：:])\s*(?:\d+[.、)]|[-*+•])\s*/g, '$1 ')
    .replace(/^\s*(?:\d+[.、)]|[-*+])\s*/gm, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function splitBySentencePunctuation(text: string): string[] {
  const normalized = stripListMarkers(text.replace(/\r/g, '').trim())
  if (!normalized) {
    return []
  }

  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  const parts = lines.flatMap((line) => splitSentenceLine(line))
  return parts.length > 0 ? parts : [normalized]
}

function mergeIntoMaxSegments(sentences: string[], maxSegments: number): string[] {
  const cappedMax = Math.max(1, Math.min(maxSegments, 6))
  if (sentences.length <= cappedMax) {
    return sentences
  }

  const targetCount = cappedMax
  const result: string[] = []
  let cursor = 0

  for (let bucket = 0; bucket < targetCount; bucket += 1) {
    const remainingSentences = sentences.length - cursor
    const remainingBuckets = targetCount - bucket
    const takeCount =
      bucket === targetCount - 1
        ? remainingSentences
        : Math.ceil(remainingSentences / remainingBuckets)

    result.push(sentences.slice(cursor, cursor + takeCount).join(' '))
    cursor += takeCount
  }

  return result.filter(Boolean)
}

const OPENING_FILLERS = ['嗯，', '嗯…', '哈，', '啊，', 'emmm，']
const TRANSITION_FILLERS = ['然后呢…', '对了，', '话说，', '还有，', '哦对，']
const SELF_CORRECTIONS = ['不对，', '我是说，', '等下，', '换个说法，']

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

export interface FillerOptions {
  intimacyScore: number
  verbalTics?: string[]
  estrangementLevel?: number
}

function injectFillers(segments: string[], options: FillerOptions): string[] {
  if (segments.length === 0) return segments

  const estrangementBoost = options.estrangementLevel && options.estrangementLevel > 30 ? 1.5 : 1
  const fillerChance = Math.min(0.35, options.intimacyScore / 200) * estrangementBoost
  const result = [...segments]

  if (Math.random() < fillerChance) {
    const tics = options.verbalTics && options.verbalTics.length > 0 ? options.verbalTics : OPENING_FILLERS
    result[0] = pickRandom(tics) + result[0]
  }

  for (let i = 1; i < result.length; i += 1) {
    if (Math.random() < fillerChance * 0.6) {
      result[i] = pickRandom(TRANSITION_FILLERS) + result[i]
    }
  }

  if (result.length >= 2 && Math.random() < 0.05) {
    const idx = 1 + Math.floor(Math.random() * (result.length - 1))
    result[idx] = pickRandom(SELF_CORRECTIONS) + result[idx]
  }

  return result
}

const TYPO_CORRECTIONS = ['*', '啊不，', '打错了，']

function introduceTypo(text: string): { typoText: string; correctionSnippet: string } {
  const chars = [...text]
  if (chars.length < 4) return { typoText: text, correctionSnippet: '' }

  const pos = 1 + Math.floor(Math.random() * (chars.length - 2))
  const original = chars[pos]
  const typoChars = [...chars]

  if (Math.random() < 0.5 && pos + 1 < chars.length) {
    typoChars[pos] = typoChars[pos + 1]
    typoChars[pos + 1] = original
  } else {
    typoChars.splice(pos, 0, original)
  }

  const correctionSnippet = chars.slice(Math.max(0, pos - 1), Math.min(chars.length, pos + 3)).join('')
  return { typoText: typoChars.join(''), correctionSnippet }
}

function injectTypo(segments: string[], options: FillerOptions): string[] {
  if (segments.length < 2) return segments

  const typoChance = Math.min(0.12, (options.intimacyScore / 1000) + 0.04)
  if (Math.random() > typoChance) return segments

  const candidates = segments
    .map((seg, idx) => ({ seg, idx }))
    .filter(({ seg, idx }) => idx >= 1 && seg.length > 6)

  if (candidates.length === 0) return segments

  const target = pickRandom(candidates)
  const { typoText, correctionSnippet } = introduceTypo(target.seg)
  if (!correctionSnippet) return segments

  const result = [...segments]
  result[target.idx] = typoText
  const correction = pickRandom(TYPO_CORRECTIONS) + correctionSnippet
  result.splice(target.idx + 1, 0, correction)
  return result
}

export function normalizeSegmentsFromText(text: string, maxSegments: number, fillerOptions?: FillerOptions): string[] {
  const sentences = splitBySentencePunctuation(text)
  const merged = mergeIntoMaxSegments(sentences, maxSegments)
  if (fillerOptions) {
    const withFillers = injectFillers(merged, fillerOptions)
    return injectTypo(withFillers, fillerOptions)
  }
  return merged
}

export function normalizeSegments(input: string[], maxSegments: number, fillerOptions?: FillerOptions): string[] {
  return normalizeSegmentsFromText(input.join('\n').trim(), maxSegments, fillerOptions)
}
