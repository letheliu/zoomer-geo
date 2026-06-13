import { describe, it, expect, vi, beforeEach } from 'vitest'
import { contentRouter } from './router.js'

function createCaller(ctx: any) {
  return contentRouter.createCaller(ctx)
}

describe('content router', () => {
  const mockOrchestrator = {
    optimize: vi.fn().mockResolvedValue({
      atoms: [],
      faqs: [],
      overallScore: 85,
      rewrittenCount: 1,
      report: { atomizationRate: 1, independenceRate: 1, faqCoverage: 0.5 },
    }),
  }
  const mockAtomizer = {
    atomize: vi.fn().mockResolvedValue([
      { text: 'atom', subject: 'x', predicate: 'y', object: 'z', anchors: [] },
    ]),
  }
  const mockFaqGenerator = {
    generate: vi.fn().mockResolvedValue([
      { question: 'Q', answer: 'A', source: 'llm_generated' },
    ]),
  }
  const mockPrisma = {
    contentPage: {
      upsert: vi.fn().mockImplementation(async (args: any) => ({
        id: 'page-1',
        ...args.create,
      })),
      findMany: vi.fn().mockResolvedValue([
        { id: 'page-1', url: 'https://example.com', status: 'DRAFT' },
      ]),
      findUnique: vi.fn().mockResolvedValue({ id: 'page-1', url: 'https://example.com' }),
    },
  }

  const ctx = {
    workspace: { id: 'w1' },
    services: {
      orchestrator: mockOrchestrator,
      atomizer: mockAtomizer,
      faqGenerator: mockFaqGenerator,
      prisma: mockPrisma,
    },
  } as any

  beforeEach(() => vi.clearAllMocks())

  it('optimize 触发完整流水线', async () => {
    const caller = createCaller(ctx)
    const result = await caller.optimize({
      content: '原始内容',
      url: 'https://example.com',
    })
    expect(mockOrchestrator.optimize).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        content: '原始内容',
      }),
    )
    expect(result.overallScore).toBe(85)
  })

  it('atomize 单独原子化', async () => {
    const caller = createCaller(ctx)
    const result = await caller.atomize({ text: '测试文本' })
    expect(mockAtomizer.atomize).toHaveBeenCalledWith('测试文本')
    expect(result.atoms).toHaveLength(1)
  })

  it('generateFaq 单独生成 FAQ', async () => {
    const caller = createCaller(ctx)
    const result = await caller.generateFaq({ topic: 'AI设计', count: 3 })
    expect(mockFaqGenerator.generate).toHaveBeenCalled()
    expect(result.faqs).toHaveLength(1)
  })

  it('pages.upsert 创建或更新页面', async () => {
    const caller = createCaller(ctx)
    await caller.pages.upsert({
      url: 'https://example.com',
      pageType: 'landing',
      currentContent: '内容',
    })
    expect(mockPrisma.contentPage.upsert).toHaveBeenCalled()
    const args = mockPrisma.contentPage.upsert.mock.calls[0][0]
    expect(args.create.workspaceId).toBe('w1')
  })

  it('pages.list 按 workspace 查询页面', async () => {
    const caller = createCaller(ctx)
    const result = await caller.pages.list()
    expect(mockPrisma.contentPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'w1' }) }),
    )
    expect(result).toHaveLength(1)
  })

  it('pages.list 按状态过滤', async () => {
    const caller = createCaller(ctx)
    await caller.pages.list({ status: 'draft' })
    expect(mockPrisma.contentPage.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'DRAFT' },
    })
  })
})
