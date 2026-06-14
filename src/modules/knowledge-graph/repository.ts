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
  findEntityById(workspaceId: string, id: string): Promise<KgEntity | null>
  findEntities(workspaceId: string, opts?: { type?: string }): Promise<KgEntity[]>
  addEntity(input: {
    workspaceId: string
    name: string
    type: string
    properties: Record<string, unknown>
    sourceUrl?: string
  }): Promise<KgEntity>
  removeEntity(id: string): Promise<void>

  findRelations(workspaceId: string, opts?: { fromId?: string; toId?: string }): Promise<KgRelation[]>
  addRelation(input: {
    workspaceId: string
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

    async findEntityById(workspaceId, id) {
      return prisma.kgEntity.findFirst({ where: { id, workspaceId } })
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

    async findRelations(workspaceId, opts) {
      const where: any = {
        fromEntity: { workspaceId },
        toEntity: { workspaceId },
      }
      if (opts?.fromId) where.fromEntityId = opts.fromId
      if (opts?.toId) where.toEntityId = opts.toId
      return prisma.kgRelation.findMany({ where })
    },

    async addRelation(input) {
      // 解析两端实体（限定在同一 workspace）
      const [from, to] = await Promise.all([
        prisma.kgEntity.findUnique({
          where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.fromName } },
        }),
        prisma.kgEntity.findUnique({
          where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.toName } },
        }),
      ])
      if (!from) throw new EntityNotFoundError(input.workspaceId, input.fromName)
      if (!to) throw new EntityNotFoundError(input.workspaceId, input.toName)

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