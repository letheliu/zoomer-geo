import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueryLibraryService } from './query-library.js'

function mockPrisma() {
  return {
    citationQuery: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'q-1',
        ...args.data,
        status: 'ACTIVE',
      })),
      findMany: vi.fn().mockResolvedValue([
        { id: 'q1', queryText: 'AI设计工具', status: 'ACTIVE', workspaceId: 'w1' },
      ]),
      update: vi.fn().mockImplementation(async (args: any) => ({
        id: args.where.id,
        ...args.data,
      })),
      delete: vi.fn().mockResolvedValue({ id: 'q1' }),
    },
  } as any
}

describe('query library service', () => {
  let prisma: ReturnType<typeof mockPrisma>
  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('addQuery 创建 MANUAL query', async () => {
    const svc = createQueryLibraryService(prisma)
    const q = await svc.addQuery({
      workspaceId: 'w1',
      queryText: 'AI设计工具',
      source: 'MANUAL',
    })
    expect(q.id).toBe('q-1')
    expect(prisma.citationQuery.create).toHaveBeenCalled()
    const data = prisma.citationQuery.create.mock.calls[0][0].data
    expect(data.source).toBe('MANUAL')
    expect(data.status).toBe('ACTIVE')
  })

  it('listActive 返回 ACTIVE 状态 query', async () => {
    const svc = createQueryLibraryService(prisma)
    const list = await svc.listActive('w1')
    expect(list).toHaveLength(1)
    expect(list[0].queryText).toBe('AI设计工具')
    expect(prisma.citationQuery.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'ACTIVE' },
    })
  })

  it('pauseQuery 设置状态为 PAUSED', async () => {
    const svc = createQueryLibraryService(prisma)
    await svc.pauseQuery('q1')
    expect(prisma.citationQuery.update).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { status: 'PAUSED' },
    })
  })

  it('generateQueries 调用 LLM 并批量创建', async () => {
    const llm = {
      name: 'test',
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify(['Q1', 'Q2', 'Q3']),
      }),
      embed: vi.fn(),
    }
    const svc = createQueryLibraryService(prisma, llm as any)
    const result = await svc.generateQueries({
      workspaceId: 'w1',
      topic: 'AI设计工具',
      count: 3,
    })
    expect(result).toHaveLength(3)
    expect(llm.chat).toHaveBeenCalled()
    expect(prisma.citationQuery.create).toHaveBeenCalledTimes(3)
  })

  it('generateQueries 解析结构化 LLM 输出', async () => {
    const llm = {
      name: 'test',
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify([
          {
            queryText: 'AI 设计工具哪个好',
            intentType: 'comparison',
            cluster: 'ai-design-tools',
            mappedPageUrl: 'https://zoomer.top/features',
            priority: 1,
          },
        ]),
      }),
      embed: vi.fn(),
    }
    const svc = createQueryLibraryService(prisma, llm as any)
    const result = await svc.generateQueries({
      workspaceId: 'w1',
      topic: 'AI 设计工具',
      count: 1,
    })

    expect(result).toHaveLength(1)
    expect(prisma.citationQuery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'w1',
        queryText: 'AI 设计工具哪个好',
        source: 'LLM_GENERATED',
        status: 'ACTIVE',
        intentType: 'comparison',
        cluster: 'ai-design-tools',
        mappedPageUrl: 'https://zoomer.top/features',
        priority: 1,
      }),
    })
  })

  it('generateQueries 兼容旧格式字符串数组', async () => {
    const llm = {
      name: 'test',
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify(['AI 设计工具推荐']),
      }),
      embed: vi.fn(),
    }
    const svc = createQueryLibraryService(prisma, llm as any)
    const result = await svc.generateQueries({
      workspaceId: 'w1',
      topic: 'AI 设计工具',
      count: 1,
    })

    expect(result).toHaveLength(1)
    expect(prisma.citationQuery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        queryText: 'AI 设计工具推荐',
        intentType: 'other',
        priority: 3,
      }),
    })
  })

  it('addQuery 支持结构化字段', async () => {
    const svc = createQueryLibraryService(prisma)
    await svc.addQuery({
      workspaceId: 'w1',
      queryText: 'AI设计工具',
      source: 'MANUAL',
      intentType: 'comparison',
      cluster: 'ai-design',
      mappedPageUrl: 'https://zoomer.top',
      priority: 1,
    })

    expect(prisma.citationQuery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        intentType: 'comparison',
        cluster: 'ai-design',
        mappedPageUrl: 'https://zoomer.top',
        priority: 1,
      }),
    })
  })
})
