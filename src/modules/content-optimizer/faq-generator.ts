import type { PrismaClient } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'
import type { Atom, FaqPair } from './types.js'

export interface GenerateFaqInput {
  atoms: Atom[]
  workspaceId?: string
  queries?: Array<{ id: string; queryText: string }>
  count?: number
}

export interface FaqGeneratorService {
  generate(input: GenerateFaqInput): Promise<FaqPair[]>
}

export function createFaqGenerator(
  llm: LlmProvider,
  prisma?: PrismaClient,
): FaqGeneratorService {
  return {
    async generate(input) {
      const count = input.count ?? 5

      // 确定是否有 query 来源
      let queries: Array<{ id: string; queryText: string }> | undefined

      if (input.queries && input.queries.length > 0) {
        queries = input.queries
      } else if (prisma && input.workspaceId) {
        queries = await prisma.citationQuery.findMany({
          where: { workspaceId: input.workspaceId, status: 'ACTIVE' },
        })
      }

      const hasQueries = queries && queries.length > 0

      if (hasQueries) {
        return generateFromQueries(llm, input.atoms, queries!, count)
      }
      return generateFromAtoms(llm, input.atoms, count)
    },
  }
}

async function generateFromQueries(
  llm: LlmProvider,
  atoms: Atom[],
  queries: Array<{ id: string; queryText: string }>,
  count: number,
): Promise<FaqPair[]> {
  const selectedQueries = queries.slice(0, count)
  const contentContext = atoms.map((a) => a.text).join('\n')

  const prompt = `基于以下内容和用户高频问题，生成问答对。

内容：
${contentContext}

用户问题：
${selectedQueries.map((q, i) => `${i + 1}. ${q.queryText}`).join('\n')}

为每个问题生成简洁准确的答案。只输出 JSON：{ "faqs": [{ "question": "...", "answer": "...", "matchedQueryId": "..." }] }`

  const res = await llm.chat(
    [{ role: 'user', content: prompt }],
    { temperature: 0.3 },
  )

  return parseFaqs(res.text, 'citation_query')
}

async function generateFromAtoms(
  llm: LlmProvider,
  atoms: Atom[],
  count: number,
): Promise<FaqPair[]> {
  const contentContext = atoms.map((a) => a.text).join('\n')

  const prompt = `基于以下内容，从 5W1H（What/Who/When/Where/Why/How）角度生成 ${count} 个问答对。

内容：
${contentContext}

只输出 JSON：{ "faqs": [{ "question": "...", "answer": "..." }] }`

  const res = await llm.chat(
    [{ role: 'user', content: prompt }],
    { temperature: 0.5 },
  )

  return parseFaqs(res.text, 'llm_generated')
}

function parseFaqs(
  raw: string,
  source: 'citation_query' | 'llm_generated',
): FaqPair[] {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.faqs)) {
      return parsed.faqs.map((f: any) => ({
        question: String(f.question || ''),
        answer: String(f.answer || ''),
        matchedQueryId: f.matchedQueryId ? String(f.matchedQueryId) : undefined,
        source,
      }))
    }
  } catch {
    // 兜底
  }
  return []
}
