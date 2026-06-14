import type { PrismaClient, KgEntity, KgRelation } from '@prisma/client'

export class DuplicateEntityError extends Error {
  constructor(public workspaceId: string, public name: string) {
    super(`KgEntity already exists: workspaceId="${workspaceId}" name="${name}"`)
    this.name = 'DuplicateEntityError'
  }
}

export class EntityNotFoundError extends Error {
  constructor(public workspaceId: string, public name: string) {
    super(`KgEntity not found: workspaceId="${workspaceId}" name="${name}"`)
    this.name = 'EntityNotFoundError'
  }
}

export interface KgRepositoryService {
  findEntityByName(workspaceId: string, name: string): Promise<KgEntity | null>
  findEntityById(id: string): Promise<KgEntity | null>
  findEntities(workspaceId: string, opts?: { type?: string }): Promise<KgEntity[]>
  addEntity(input: {
    workspaceId: string
    name: string
    type: string
    properties: Record<string, unknown>
    sourceUrl?: string
  }): Promise<KgEntity>
  removeEntity(id: string): Promise<void>

  findRelations(opts: { fromId?: string; toId?: string }): Promise<KgRelation[]>
  addRelation(input: {
    fromName: string
    toName: string
    relationType: string
    properties?: Record<string, unknown>
  }): Promise<KgRelation>
}

export function createKgRepository(prisma: PrismaClient): KgRepositoryService {
  return {
    async findEntityByName(workspaceId, name) {
      return prisma.kgEntity.findUnique({
        where: { workspaceId_name: { workspaceId, name } },
      })
    },

    async findEntityById(id) {
      return prisma.kgEntity.findUnique({ where: { id } })
    },

    async findEntities(workspaceId, opts) {
      const where: any = { workspaceId }
      if (opts?.type) where.type = opts.type
      return prisma.kgEntity.findMany({ where })
    },

    async addEntity(input) {
      const existing = await prisma.kgEntity.findUnique({
        where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.name } },
      })
      if (existing) throw new DuplicateEntityError(input.workspaceId, input.name)
      return prisma.kgEntity.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name,
          type: input.type,
          properties: input.properties as any,
          sourceUrl: input.sourceUrl,
        },
      })
    },

    async removeEntity(id) {
      await prisma.kgEntity.delete({ where: { id } })
    },

    async findRelations(opts) {
      const where: any = {}
      if (opts.fromId) where.fromEntityId = opts.fromId
      if (opts.toId) where.toEntityId = opts.toId
      return prisma.kgRelation.findMany({ where })
    },

    async addRelation(input) {
      // 解析两端实体的 workspaceId（通过 findFirst 按 name 查）
      const [from, to] = await Promise.all([
        prisma.kgEntity.findFirst({ where: { name: input.fromName } }),
        prisma.kgEntity.findFirst({ where: { name: input.toName } }),
      ])
      const fromWs = from?.workspaceId ?? ''
      const toWs = to?.workspaceId ?? ''
      if (!from) throw new EntityNotFoundError(fromWs, input.fromName)
      if (!to) throw new EntityNotFoundError(toWs, input.toName)

      return prisma.kgRelation.create({
        data: {
          fromEntityId: from.id,
          toEntityId: to.id,
          relationType: input.relationType,
          properties: (input.properties as any) ?? {},
        },
      })
    },
  }
}