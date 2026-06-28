import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'

export class PerplexityAdapter implements PlatformAdapter {
  name = 'perplexity'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.PERPLEXITY_API_KEY
    const baseUrl = credentials.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai'
    const model = credentials.PERPLEXITY_MODEL || 'llama-3.1-sonar-small-128k-online'

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: text }],
      }),
    })
    if (!res.ok) {
      throw new Error(`Perplexity adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
      citations?: string[]
    }
    const answer = json.choices[0].message.content
    const sourceCitations: SourceCitation[] = (json.citations || []).map((url, i) => ({
      url,
      position: i + 1,
      sourceType: 'api_citation' as const,
    }))

    return {
      answer,
      sourceCitations,
      groundingSources: [],
      answerMentions: [],
      raw: json,
    }
  }
}
