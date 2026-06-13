import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTaskService } from './task-service.js'

function mockPrisma() {
  return {
    optimizationTask: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'task-1',
        ...args.data,
      })),
      findMany: vi.fn().mockResolvedValue([
        { id: 'task-1', status: 'PENDING', workspaceId: 'w1' },
      ]),
      findUnique: vi.fn().mockImplementation(async (args: any) => ({
        id: args.where.id,
        status: 'PENDING',
        workspaceId: 'w1',
        pageId: 'page-1',
      })),
      update: vi.fn().mockImplementation(async (args: any) => ({
        id: args.where.id,
        ...args.data,
      })),
    },
    contentPage: {
      update: vi.fn().mockResolvedValue({}),
    },
  } as any
}

describe('OptimizationTaskService', () => {
  let prisma: ReturnType<typeof mockPrisma>

  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('create 创建任务', async () => {
    const svc = createTaskService(prisma)
    const task = await svc.create({
      workspaceId: 'w1',
      type: 'REWRITE_CONTENT',
      pageId: 'page-1',
      beforeScore: 40,
      afterScore: 85,
    })
    expect(task.id).toBe('task-1')
    expect(prisma.optimizationTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'w1',
        type: 'REWRITE_CONTENT',
        status: 'PENDING',
      }),
    })
  })

  it('list 按 workspace 查询任务', async () => {
    const svc = createTaskService(prisma)
    const tasks = await svc.list('w1')
    expect(tasks).toHaveLength(1)
    expect(prisma.optimizationTask.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1' },
    })
  })

  it('list 按 workspace + status 过滤', async () => {
    const svc = createTaskService(prisma)
    await svc.list('w1', 'PENDING')
    expect(prisma.optimizationTask.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'PENDING' },
    })
  })

  it('getById 查询单个任务', async () => {
    const svc = createTaskService(prisma)
    const task = await svc.getById('task-1')
    expect(task?.id).toBe('task-1')
  })

  it('review approve 时 status 变为 REVIEWED，同时更新 ContentPage', async () => {
    const svc = createTaskService(prisma)
    const task = await svc.review('task-1', true)
    expect(task.status).toBe('REVIEWED')
    expect(prisma.optimizationTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'REVIEWED' },
    })
    expect(prisma.contentPage.update).toHaveBeenCalled()
  })

  it('review reject 时 status 退回 PENDING 并记录 reviewNote', async () => {
    const svc = createTaskService(prisma)
    const task = await svc.review('task-1', false, '内容不准确')
    expect(task.status).toBe('PENDING')
    expect(prisma.optimizationTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'PENDING', reviewNote: '内容不准确' },
    })
  })

  it('publish 将 REVIEWED 任务变为 PUBLISHED', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'REVIEWED',
      pageId: 'page-1',
    })
    const svc = createTaskService(prisma)
    const task = await svc.publish('task-1')
    expect(task.status).toBe('PUBLISHED')
    expect(prisma.optimizationTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'PUBLISHED' },
    })
  })

  it('publish 非 REVIEWED 任务时报错', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'PENDING',
    })
    const svc = createTaskService(prisma)
    await expect(svc.publish('task-1')).rejects.toThrow()
  })
})
