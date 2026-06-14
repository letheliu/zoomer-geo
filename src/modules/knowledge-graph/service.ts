import type { PrismaClient, KgEntity, KgRelation, OptimizationTask } from '@prisma/client'
import type { KgRepositoryService } from './repository.js'
import type { KgExtractorService } from './extractor.js'
import type { GraphExporterService } from './exporter.js'
import type { KgProposalSet, ExportInput } from './types.js'

export interface KgService {
  // 手动 CRUD
  addEntity(input: { workspaceId: string; name: string; type: string; properties: Record<string, unknown>; sourceUrl?: string }): Promise<KgEntity>
  addRelation(input: { fromName: string; toName: string; relationType: string; properties?: Record<string, unknown> }): Promise<KgRelation>
  removeEntity(id: string): Promise<void>

  // 自动抽取
  extractFromPage(pageId: string): Promise<OptimizationTask>

  // 持久化提案（taskService onPublished 回调调用）
  persistProposals(workspaceId: string, proposals: KgProposalSet): Promise<{
    entitiesCreated: number
    entitiesSkipped: number
    relationsCreated: number
    relationsSkipped: number
  }>

  // 查询
  listEntities(workspaceId: string, opts?: { type?: string }): Promise<KgEntity[]>
  listRelations(opts: { fromId?: string; toId?: string }): Promise<KgRelation[]>
  getEntity(id: string): Promise<KgEntity | null>

  // 导出
  exportGraph(input: ExportInput): Promise<string>
}

export function createKgService(deps: {
  prisma: PrismaClient
  repository: KgRepositoryService
  extractor: KgExtractorService
  exporter: GraphExporterService
}): KgService {
  return {
    addEntity: (input) => deps.repository.addEntity(input),
    addRelation: (input) => deps.repository.addRelation(input),
    removeEntity: (id) => deps.repository.removeEntity(id),
    extractFromPage: (pageId) => deps.extractor.extractFromPage(pageId).then((r) => r.task),

    async persistProposals(workspaceId, proposals) {
      let entitiesCreated = 0
      let entitiesSkipped = 0

      // 1. 实体去重后入库
      for (const e of proposals.entities) {
        const existing = await deps.repository.findEntityByName(workspaceId, e.name)
        if (existing) {
          entitiesSkipped++
          continue
        }
        try {
          await deps.repository.addEntity({
            workspaceId,
            name: e.name,
            type: e.type,
            properties: e.properties,
            sourceUrl: e.sourceUrl ?? proposals.sourcePageUrl,
          })
          entitiesCreated++
        } catch {
          entitiesSkipped++
        }
      }

      // 2. 关系（两端实体都已存在才创建）
      let relationsCreated = 0
      let relationsSkipped = 0
      for (const r of proposals.relations) {
        const [from, to] = await Promise.all([
          deps.repository.findEntityByName(workspaceId, r.fromName),
          deps.repository.findEntityByName(workspaceId, r.toName),
        ])
        if (!from || !to) {
          relationsSkipped++
          continue
        }
        try {
          await deps.repository.addRelation({
            fromName: r.fromName,
            toName: r.toName,
            relationType: r.relationType,
            properties: r.properties,
          })
          relationsCreated++
        } catch {
          relationsSkipped++
        }
      }

      return { entitiesCreated, entitiesSkipped, relationsCreated, relationsSkipped }
    },

    listEntities: (workspaceId, opts) => deps.repository.findEntities(workspaceId, opts),
    listRelations: (opts) => deps.repository.findRelations(opts),
    getEntity: (id) => deps.repository.findEntityById(id),
    exportGraph: (input) => deps.exporter.export(input),
  }
}
