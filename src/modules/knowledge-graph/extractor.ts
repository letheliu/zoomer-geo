import type { PrismaClient, OptimizationTask } from '@prisma/client'
import type { EntityExtractorService } from '../../core/extract/entity-extractor.js'
import type { KgAdapterService } from '../../core/extract/adapters/kg-adapter.js'
import type { KgProposalSet } from './types.js'

export interface KgExtractorService {
  extractFromPage(pageId: string): Promise<{ proposals: KgProposalSet; task: OptimizationTask }>
}

export function createKgExtractor(deps: {
  prisma: PrismaClient
  extractor: EntityExtractorService
  kgAdapter: KgAdapterService
}): KgExtractorService {
  return {
    async extractFromPage(pageId) {
      const page = await deps.prisma.contentPage.findUnique({ where: { id: pageId } })
      if (!page) throw new Error(`Page not found: ${pageId}`)

      const extraction = await deps.extractor.extract(page.currentContent)
      const entities = deps.kgAdapter.adapt(extraction.entities)

      const proposals: KgProposalSet = {
        entities,
        relations: extraction.relations.map((r) => ({
          fromName: r.fromName,
          toName: r.toName,
          relationType: r.relationType,
          properties: r.properties,
        })),
        sourcePageUrl: page.url,
        extractedAt: new Date().toISOString(),
      }

      const task = await deps.prisma.optimizationTask.create({
        data: {
          workspaceId: page.workspaceId,
          type: 'UPDATE_KG',
          status: 'PENDING',
          pageId,
          result: proposals as any,
          extractionProposals: proposals as any,
        },
      })

      return { proposals, task }
    },
  }
}
