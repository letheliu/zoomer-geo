import { describe, it, expect } from 'vitest'
import { analyzeCitation } from './analyzer.js'
import type { PlatformResult } from './platform-adapters/types.js'

function makeResult(answer: string): PlatformResult {
  return { answer, citations: [], mentionedBrands: [] }
}

describe('CitationAnalyzer', () => {
  it('检测品牌被提及（大小写不敏感）', () => {
    const result = analyzeCitation({
      platformResult: makeResult('推荐 Zoomer AI 给设计师'),
      brand: 'zoomer AI',
      competitors: ['figma'],
    })
    expect(result.brandMentioned).toBe(true)
  })

  it('品牌未被提及时 brandMentioned=false', () => {
    const result = analyzeCitation({
      platformResult: makeResult('推荐 Figma'),
      brand: 'zoomer AI',
      competitors: ['figma'],
    })
    expect(result.brandMentioned).toBe(false)
  })

  it('计算品牌排名（在所有提及品牌中的顺序）', () => {
    const result = analyzeCitation({
      platformResult: makeResult('第一是 Figma，第二是 zoomer AI，第三是 Sketch'),
      brand: 'zoomer AI',
      competitors: ['figma', 'sketch'],
    })
    expect(result.rankInAnswer).toBe(2)
  })

  it('计算 SOV（品牌提及次数 / 所有品牌提及总和）', () => {
    const result = analyzeCitation({
      platformResult: makeResult('zoomer AI 和 zoomer AI 以及 Figma'),
      brand: 'zoomer AI',
      competitors: ['figma'],
    })
    expect(result.sovScore).toBeCloseTo(2 / 3, 2)
  })

  it('竞品列表标记每个竞品是否提及及其排名', () => {
    const result = analyzeCitation({
      platformResult: makeResult('zoomer AI 最好，Figma 次之'),
      brand: 'zoomer AI',
      competitors: ['figma', 'sketch'],
    })
    const figma = result.competitors.find((c) => c.brand === 'figma')
    const sketch = result.competitors.find((c) => c.brand === 'sketch')
    expect(figma?.mentioned).toBe(true)
    expect(figma?.rank).toBe(2)
    expect(sketch?.mentioned).toBe(false)
    expect(sketch?.rank).toBeNull()
  })
})
