import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class GeminiAdapter implements PlatformAdapter {
  name = 'gemini'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.GEMINI_API_KEY
    const baseUrl =
      credentials.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
    const model = credentials.GEMINI_MODEL || 'gemini-1.5-flash'

    const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
      }),
    })
    if (!res.ok) {
      throw new Error(`Gemini adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      candidates?: {
        content: { parts: { text: string }[] }
        groundingMetadata?: {
          groundingChunks?: { web: { uri: string; title?: string } }[]
        }
      }[]
    }
    const parts = json.candidates?.[0]?.content?.parts || []
    const answer = parts.map((p) => p.text).join('')

    const groundingChunks = json.candidates?.[0]?.groundingMetadata?.groundingChunks || []
    const groundingSources: SourceCitation[] = groundingChunks.map((chunk, i) => ({
      url: chunk.web.uri,
      title: chunk.web.title,
      position: i + 1,
      sourceType: 'grounding' as const,
    }))

    const matches = [...answer.matchAll(URL_REGEX)]
    const sourceCitations: SourceCitation[] = matches.map((m, i) => ({
      url: m[0],
      position: i + 1,
      sourceType: 'answer_url' as const,
    }))

    return {
      answer,
      sourceCitations,
      groundingSources,
      answerMentions: [],
      raw: json,
    }
  }
}
