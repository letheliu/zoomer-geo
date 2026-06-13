import type { PrismaClient, CitationEvent } from '@prisma/client'
import type { AdapterRegistry } from './platform-adapters/registry.js'
import type { QueryLibraryService } from './query-library.js'
import { analyzeCitation } from './analyzer.js'

export interface MonitorDeps {
  prisma: PrismaClient
  registry: AdapterRegistry
  queryLibrary: QueryLibraryService
  competitors: string[]
  concurrency?: number
}

export interface RunOnceInput {
  workspaceId: string
  platforms: string[]
}

export interface Monitor {
  runOnce(input: RunOnceInput): Promise<CitationEvent[]>
}

export function createMonitor(deps: MonitorDeps): Monitor {
  const concurrency = deps.concurrency ?? 3

  async function processOne(
    query: { id: string; workspaceId: string; queryText: string },
    platform: string,
    workspace: { defaultBrandName: string; platformConfig: any },
  ): Promise<CitationEvent | null> {
    const adapter = deps.registry.get(platform)
    if (!adapter) return null
    const credentials = workspace.platformConfig?.[platform] || {}
    try {
      const platformResult = await adapter.query(query.queryText, credentials)
      const analysis = analyzeCitation({
        platformResult,
        brand: workspace.defaultBrandName,
        competitors: deps.competitors,
      })
      return deps.prisma.citationEvent.create({
        data: {
          workspaceId: query.workspaceId,
          queryId: query.id,
          platform,
          brandMentioned: analysis.brandMentioned,
          rankInAnswer: analysis.rankInAnswer,
          citedUrls: platformResult.citations as any,
          competitors: analysis.competitors as any,
          rawAnswer: platformResult.answer,
          sovScore: analysis.sovScore,
        },
      })
    } catch (err) {
      console.error(`[monitor] query=${query.id} platform=${platform} failed:`, err)
      return null
    }
  }

  return {
    async runOnce(input) {
      const workspace = await deps.prisma.workspace.findUnique({
        where: { id: input.workspaceId },
      })
      if (!workspace) throw new Error(`Workspace not found: ${input.workspaceId}`)

      const queries = await deps.queryLibrary.listActive(input.workspaceId)
      const tasks: Promise<CitationEvent | null>[] = []
      for (const q of queries) {
        for (const platform of input.platforms) {
          tasks.push(processOne(q, platform, workspace as any))
        }
      }
      // 简单并发控制：分批
      const results: (CitationEvent | null)[] = []
      for (let i = 0; i < tasks.length; i += concurrency) {
        const batch = tasks.slice(i, i + concurrency)
        results.push(...(await Promise.all(batch)))
      }
      return results.filter((r): r is CitationEvent => r !== null)
    },
  }
}
