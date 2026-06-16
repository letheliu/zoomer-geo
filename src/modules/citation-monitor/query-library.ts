import type { PrismaClient, CitationQuery, QuerySource } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'

export interface AddQueryInput {
  workspaceId: string
  queryText: string
  source: QuerySource
  intent?: Record<string, unknown>
}

export interface GenerateQueriesInput {
  workspaceId: string
  topic: string
  count: number
}

export interface QueryLibraryService {
  addQuery(input: AddQueryInput): Promise<CitationQuery>
  listActive(workspaceId: string): Promise<CitationQuery[]>
  pauseQuery(id: string): Promise<CitationQuery>
  deleteQuery(id: string): Promise<void>
  generateQueries(input: GenerateQueriesInput): Promise<CitationQuery[]>
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
只输出 JSON 字符串数组，不要任何解释。例如：["query1","query2"]`

      const res = await llm.chat([{ role: 'user', content: prompt }], { temperature: 0.7 })
      let queries: string[]
      try {
        // 尝试提取 JSON 数组
        const text = res.text.trim()
        const jsonMatch = text.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          queries = JSON.parse(jsonMatch[0])
        } else {
          throw new Error('No JSON array found')
        }
      } catch {
        // 兜底：按行解析，过滤掉非查询文本
        queries = res.text
          .split('\n')
          .map((s) => s.trim().replace(/^["'\d]+\.?\s*/, '').replace(/["']$/, ''))
          .filter((s) => s && s.length > 2 && !s.startsWith('[') && !s.startsWith(']'))
      }

      const created: CitationQuery[] = []
      for (const q of queries.slice(0, input.count)) {
        const row = await prisma.citationQuery.create({
          data: {
            workspaceId: input.workspaceId,
            queryText: q,
            source: 'LLM_GENERATED',
            status: 'ACTIVE',
          },
        })
        created.push(row)
      }
      return created
    },
  }
}
