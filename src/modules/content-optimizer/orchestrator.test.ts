import { describe, it, expect, vi } from 'vitest'
import { createOrchestrator } from './orchestrator.js'
import type { Atom, ScoredAtom, FaqPair } from './types.js'

function makeScoredAtom(text: string, total: number): ScoredAtom {
  return {
    text,
    subject: 'x',
    predicate: 'y',
    object: 'z',
    anchors: ['123'],
    score: {
      total,
      hasNumericAnchor: total >= 35,
      hasEntityAnchor: total >= 60,
      isSelfContained: true,
      hasDefinition: total >= 75,
    },
  }
}

describe('Orchestrator', () => {
  const mockAtoms: Atom[] = [
    { text: '段落1', subject: 'a', predicate: 'b', object: 'c', anchors: ['123'] },
  ]

  function makeDeps(overrides: any = {}) {
    const defaultScored: ScoredAtom[] = [makeScoredAtom('段落1', 85)]
    const defaultFaqs: FaqPair[] = [
      { question: 'Q?', answer: 'A', source: 'llm_generated' },
    ]

    return {
      atomizer: {
        atomize: vi.fn().mockResolvedValue(mockAtoms),
        ...overrides.atomizer,
      },
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue(defaultScored),
        scorePage: vi.fn().mockReturnValue(85),
        ...overrides.scoring,
      },
      rewriter: {
        rewriteBatch: vi.fn().mockImplementation(async (atoms: ScoredAtom[]) => atoms),
        ...overrides.rewriter,
      },
      faqGenerator: {
        generate: vi.fn().mockResolvedValue(defaultFaqs),
        ...overrides.faqGenerator,
      },
      taskService: {
        create: vi.fn().mockResolvedValue({ id: 'task-1' }),
        ...overrides.taskService,
      },
      prisma: {
        contentPage: {
          upsert: vi.fn().mockResolvedValue({ id: 'page-1' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        ...overrides.prisma,
      },
    }
  }

  it('完整流水线：atomize → score → rewrite → faq → 组装结果', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: '原始内容',
    })

    expect(deps.atomizer.atomize).toHaveBeenCalledWith('原始内容')
    expect(deps.scoring.scoreAtoms).toHaveBeenCalled()
    expect(deps.rewriter.rewriteBatch).toHaveBeenCalled()
    expect(deps.faqGenerator.generate).toHaveBeenCalled()
    expect(result.atoms).toHaveLength(1)
    expect(result.faqs).toHaveLength(1)
    expect(result.overallScore).toBe(85)
  })

  it('所有 atom 达标时 rewrittenCount 为 0', async () => {
    const deps = makeDeps({
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue([makeScoredAtom('a', 100)]),
        scorePage: vi.fn().mockReturnValue(100),
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
    })

    expect(result.rewrittenCount).toBe(0)
  })

  it('部分不达标时记录 rewrittenCount', async () => {
    const lowScore = makeScoredAtom('低分', 40)
    const highScore = makeScoredAtom('高分', 90)
    const rewrittenLow = makeScoredAtom('低分-改写后', 85)

    const deps = makeDeps({
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue([lowScore, highScore]),
        scorePage: vi.fn().mockReturnValue(85),
      },
      rewriter: {
        rewriteBatch: vi.fn().mockResolvedValue([rewrittenLow, highScore]),
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
    })

    expect(deps.rewriter.rewriteBatch).toHaveBeenCalled()
    expect(result.rewrittenCount).toBe(1)
  })

  it('报告指标正确计算', async () => {
    const atoms: ScoredAtom[] = [
      makeScoredAtom('a', 85),
      makeScoredAtom('b', 40),
    ]
    const deps = makeDeps({
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue(atoms),
        scorePage: vi.fn().mockReturnValue(62),
      },
      rewriter: {
        rewriteBatch: vi.fn().mockResolvedValue([
          makeScoredAtom('a', 85),
          makeScoredAtom('b-改', 80),
        ]),
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
    })

    // 两个 atom 都达标 → atomizationRate = 1.0
    expect(result.report.atomizationRate).toBe(1)
    // 两个都 isSelfContained → independenceRate = 1.0
    expect(result.report.independenceRate).toBe(1)
  })

  it('创建 OptimizationTask', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
      url: 'https://example.com',
      pageType: 'landing',
    })

    expect(deps.taskService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        type: 'REWRITE_CONTENT',
      }),
    )
  })

  it('传入 pageId 时读取已有 ContentPage 内容', async () => {
    const deps = makeDeps({
      prisma: {
        contentPage: {
          upsert: vi.fn(),
          findUnique: vi.fn().mockResolvedValue({
            id: 'page-1',
            currentContent: '已有内容',
            workspaceId: 'w1',
          }),
        },
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    await orchestrator.optimize({
      workspaceId: 'w1',
      content: '',
      pageId: 'page-1',
    })

    expect(deps.prisma.contentPage.findUnique).toHaveBeenCalledWith({ where: { id: 'page-1' } })
    expect(deps.atomizer.atomize).toHaveBeenCalledWith('已有内容')
  })
})
