import type { PrismaClient, OptimizationTask, TaskType, TaskStatus } from '@prisma/client'

export interface CreateTaskInput {
  workspaceId: string
  type: TaskType
  pageId?: string
  queryId?: string
  beforeScore?: number
  afterScore?: number
  result?: Record<string, unknown>
}

export interface TaskService {
  create(input: CreateTaskInput): Promise<OptimizationTask>
  list(workspaceId: string, status?: TaskStatus): Promise<OptimizationTask[]>
  getById(id: string): Promise<OptimizationTask | null>
  review(id: string, approved: boolean, note?: string): Promise<OptimizationTask>
  publish(id: string): Promise<OptimizationTask>
}

export function createTaskService(prisma: PrismaClient): TaskService {
  return {
    async create(input) {
      return prisma.optimizationTask.create({
        data: {
          workspaceId: input.workspaceId,
          type: input.type,
          pageId: input.pageId,
          queryId: input.queryId,
          beforeScore: input.beforeScore,
          afterScore: input.afterScore,
          result: (input.result as any) ?? undefined,
          status: 'PENDING',
        },
      })
    },

    async list(workspaceId, status) {
      const where: any = { workspaceId }
      if (status) where.status = status
      return prisma.optimizationTask.findMany({ where })
    },

    async getById(id) {
      return prisma.optimizationTask.findUnique({ where: { id } })
    },

    async review(id, approved, note) {
      const task = await prisma.optimizationTask.findUnique({ where: { id } })
      if (!task) throw new Error(`Task not found: ${id}`)

      if (approved) {
        const updated = await prisma.optimizationTask.update({
          where: { id },
          data: { status: 'REVIEWED' },
        })
        // 同时更新关联的 ContentPage
        if (task.pageId) {
          await prisma.contentPage.update({
            where: { id: task.pageId },
            data: { status: 'REVIEWED' },
          })
        }
        return updated
      }

      return prisma.optimizationTask.update({
        where: { id },
        data: { status: 'PENDING', reviewNote: note },
      })
    },

    async publish(id) {
      const task = await prisma.optimizationTask.findUnique({ where: { id } })
      if (!task) throw new Error(`Task not found: ${id}`)
      if (task.status !== 'REVIEWED') {
        throw new Error(`Task must be REVIEWED to publish, current: ${task.status}`)
      }

      const updated = await prisma.optimizationTask.update({
        where: { id },
        data: { status: 'PUBLISHED' },
      })
      if (task.pageId) {
        await prisma.contentPage.update({
          where: { id: task.pageId },
          data: { status: 'PUBLISHED' },
        })
      }
      return updated
    },
  }
}
