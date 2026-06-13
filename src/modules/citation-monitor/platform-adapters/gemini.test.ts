import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GeminiAdapter } from './gemini.js'

describe('GeminiAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'zoomer AI 不错。https://zoomer.top' }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('拼接 parts 文本', async () => {
    const adapter = new GeminiAdapter()
    const result = await adapter.query('AI工具', { GEMINI_API_KEY: 'gem-test' })
    expect(result.answer).toContain('zoomer AI')
  })

  it('URL 通过 query 参数传递 key', async () => {
    const adapter = new GeminiAdapter()
    await adapter.query('AI工具', { GEMINI_API_KEY: 'gem-test' })
    const calledUrl = (fetch as any).mock.calls[0][0] as string
    expect(calledUrl).toContain('key=gem-test')
  })
})
