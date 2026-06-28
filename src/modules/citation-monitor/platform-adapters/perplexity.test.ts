import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PerplexityAdapter } from './perplexity.js'

describe('PerplexityAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'zoomer AI 是一款设计工具' } }],
            citations: ['https://zoomer.top', 'https://example.com/blog'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('解析答案与 citations 数组', async () => {
    const adapter = new PerplexityAdapter()
    const result = await adapter.query('AI设计工具', { PERPLEXITY_API_KEY: 'pplx-test' })
    expect(result.answer).toContain('zoomer AI')
    expect(result.sourceCitations).toHaveLength(2)
    expect(result.sourceCitations[0]).toMatchObject({
      url: 'https://zoomer.top',
      position: 1,
      sourceType: 'api_citation',
    })
    expect(result.sourceCitations[1]).toMatchObject({
      url: 'https://example.com/blog',
      position: 2,
      sourceType: 'api_citation',
    })
  })

  it('无 citations 字段时返回空数组', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '答案' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const adapter = new PerplexityAdapter()
    const result = await adapter.query('x', { PERPLEXITY_API_KEY: 'pplx-test' })
    expect(result.sourceCitations).toEqual([])
  })
})
