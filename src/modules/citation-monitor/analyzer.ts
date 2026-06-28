import type { PlatformResult } from './platform-adapters/types.js'

export interface CompetitorMention {
  brand: string
  mentioned: boolean
  rank: number | null
}

export interface CitationAnalysis {
  brandMentioned: boolean
  brandSourceCited: boolean
  rankInAnswer: number | null
  sourceRank: number | null
  sovScore: number
  sourceCitationRate: number
  competitors: CompetitorMention[]
}

export interface AnalyzeInput {
  platformResult: PlatformResult
  brand: string
  brandDomains?: string[]
  competitors: string[]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countOccurrences(text: string, term: string): number {
  const re = new RegExp(escapeRegex(term), 'gi')
  return [...text.matchAll(re)].length
}

function firstIndex(text: string, term: string): number {
  return text.toLowerCase().indexOf(term.toLowerCase())
}

function urlMatchesDomains(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return domains.some((d) => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
}

export function analyzeCitation(input: AnalyzeInput): CitationAnalysis {
  const { platformResult, brand, brandDomains = [], competitors } = input
  const answer = platformResult.answer

  // 收集所有品牌（主品牌 + 竞品）的出现信息
  const all = [brand, ...competitors]
  const stats = all.map((name) => ({
    name,
    count: countOccurrences(answer, name),
    firstIndex: firstIndex(answer, name),
  }))

  const mentioned = stats
    .filter((s) => s.count > 0)
    .sort((a, b) => a.firstIndex - b.firstIndex)

  // 主品牌
  const brandStat = stats[0]
  const brandMentioned = brandStat.count > 0
  const rankInAnswer = brandMentioned
    ? mentioned.findIndex((s) => s.name === brand) + 1
    : null

  // SOV = 主品牌提及次数 / 所有品牌提及总次数
  const totalMentions = stats.reduce((sum, s) => sum + s.count, 0)
  const sovScore = totalMentions > 0 ? brandStat.count / totalMentions : 0

  // 竞品
  const competitorResult: CompetitorMention[] = competitors.map((name) => {
    const s = stats.find((x) => x.name === name)!
    if (s.count === 0) return { brand: name, mentioned: false, rank: null }
    const rank = mentioned.findIndex((x) => x.name === name) + 1
    return { brand: name, mentioned: true, rank }
  })

  // Source citation 分析
  const allSources = [
    ...platformResult.sourceCitations,
    ...platformResult.groundingSources,
  ]

  const brandSourceCited = allSources.some((s) => urlMatchesDomains(s.url, brandDomains))

  const sourceRank = brandSourceCited
    ? allSources.find((s) => urlMatchesDomains(s.url, brandDomains))?.position ?? null
    : null

  const sourceCitationRate = allSources.length > 0
    ? allSources.filter((s) => urlMatchesDomains(s.url, brandDomains)).length / allSources.length
    : 0

  return {
    brandMentioned,
    brandSourceCited,
    rankInAnswer,
    sourceRank,
    sovScore,
    sourceCitationRate,
    competitors: competitorResult,
  }
}
