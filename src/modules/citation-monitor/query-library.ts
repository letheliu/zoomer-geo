import type { PrismaClient, CitationQuery, QuerySource } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'

export interface AddQueryInput {
  workspaceId: string
  queryText: string
  source: QuerySource
  intent?: Record<string, unknown>
  intentType?: string
  cluster?: string
  mappedPageUrl?: string
  priority?: number
}

export interface GenerateQueriesInput {
  workspaceId: string
  topic: string
  count: number
}

export interface GeneratedQueryDraft {
  queryText: string
  intentType: string
  cluster?: string
  mappedPageUrl?: string
  priority: number
}

export interface QueryLibraryService {
  addQuery(input: AddQueryInput): Promise<CitationQuery>
  listActive(workspaceId: string): Promise<CitationQuery[]>
  pauseQuery(id: string): Promise<CitationQuery>
  deleteQuery(id: string): Promise<void>
  generateQueries(input: GenerateQueriesInput): Promise<CitationQuery[]>
}

function normalizeQueryDraft(raw: any): GeneratedQueryDraft {
  if (typeof raw === 'string') {
    return {
      queryText: raw,
      intentType: 'other',
      priority: 3,
    }
  }
  return {
    queryText: raw.queryText || String(raw),
    intentType: raw.intentType || 'other',
    cluster: raw.cluster,
    mappedPageUrl: raw.mappedPageUrl,
    priority: raw.priority || 3,
  }
}

export function createQueryLibraryService(
  prisma: PrismaClient,
  llm?: LlmProvider,
): QueryLibraryService {
  return {
    async addQuery(input) {
      return prisma.citationQuery.create({
        data: {
          workspaceId: input.workspaceId,
          queryText: input.queryText,
          source: input.source,
          intent: (input.intent as any) || {},
          intentType: input.intentType,
          cluster: input.cluster,
          mappedPageUrl: input.mappedPageUrl,
          priority: input.priority ?? 3,
          status: 'ACTIVE',
        },
      })
    },

    async listActive(workspaceId) {
      return prisma.citationQuery.findMany({
        where: { workspaceId, status: 'ACTIVE' },
      })
    },

    async pauseQuery(id) {
      return prisma.citationQuery.update({
        where: { id },
        data: { status: 'PAUSED' },
      })
    },

    async deleteQuery(id) {
      await prisma.citationQuery.delete({ where: { id } })
    },

    async generateQueries(input) {
      if (!llm) throw new Error('LLM provider required for generateQueries')
      const prompt = `为主题"${input.topic}"生成 ${input.count} 个用户可能在 AI 搜索引擎中提问的 query。
输出 JSON 数组，每个元素可以是字符串或包含以下字段的对象：
- queryText: 查询文本（必需）
- intentType: 意图类型，可选 comparison/alternative/how_to/definition/pricing/integration/other
- cluster: 查询聚类标签
- mappedPageUrl: 关联页面 URL
- priority: 优先级 1-5

示例：["query1", {"queryText":"query2","intentType":"comparison","cluster":"ai-tools","priority":1}]`

      const res = await llm.chat([{ role: 'user', content: prompt }], { temperature: 0.7 })
      let rawQueries: any[]
      try {
        const text = res.text.trim()
        const jsonMatch = text.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          rawQueries = JSON.parse(jsonMatch[0])
        } else {
          throw new Error('No JSON array found')
        }
      } catch {
        rawQueries = res.text
          .split('\n')
          .map((s) => s.trim().replace(/^["'\d]+\.?\s*/, '').replace(/["']$/, ''))
          .filter((s) => s && s.length > 2 && !s.startsWith('[') && !s.startsWith(']'))
      }

      const created: CitationQuery[] = []
      for (const raw of rawQueries.slice(0, input.count)) {
        const draft = normalizeQueryDraft(raw)
        const row = await prisma.citationQuery.create({
          data: {
            workspaceId: input.workspaceId,
            queryText: draft.queryText,
            source: 'LLM_GENERATED',
            status: 'ACTIVE',
            intentType: draft.intentType,
            cluster: draft.cluster,
            mappedPageUrl: draft.mappedPageUrl,
            priority: draft.priority,
          },
        })
        created.push(row)
      }
      return created
    },
  }
}
