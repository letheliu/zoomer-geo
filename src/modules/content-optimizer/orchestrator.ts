import type { PrismaClient } from '@prisma/client'
import type { Atom, ScoredAtom, FaqPair, OptimizationResult } from './types.js'
import type { AtomizerService } from './atomizer.js'
import type { ScoringService } from './scoring.js'
import type { RewriterService } from './rewriter.js'
import type { FaqGeneratorService } from './faq-generator.js'
import type { TaskService } from './task-service.js'

export interface OptimizeInput {
  workspaceId: string
  content: string
  pageId?: string
  url?: string
  pageType?: string
}

export interface OrchestratorService {
  optimize(input: OptimizeInput): Promise<OptimizationResult>
}

export interface OrchestratorDeps {
  atomizer: AtomizerService
  scoring: ScoringService
  rewriter: RewriterService
  faqGenerator: FaqGeneratorService
  taskService: TaskService
  prisma: PrismaClient
}

export function createOrchestrator(deps: OrchestratorDeps): OrchestratorService {
  return {
    async optimize(input) {
      // 1. 获取内容
      let content = input.content
      let pageId = input.pageId

      if (input.pageId) {
        const page = await deps.prisma.contentPage.findUnique({
          where: { id: input.pageId },
        })
        if (page) {
          content = page.currentContent
        }
      }

      // 2. 原子化
      const atoms: Atom[] = await deps.atomizer.atomize(content)
      if (atoms.length === 0) {
        return {
          atoms: [],
          faqs: [],
          overallScore: 0,
          rewrittenCount: 0,
          report: { atomizationRate: 0, independenceRate: 0, faqCoverage: 0 },
        }
      }

      // 3. 评分
      const scoredAtoms: ScoredAtom[] = deps.scoring.scoreAtoms(atoms)
      const beforeScore = deps.scoring.scorePage(scoredAtoms)
      const needsRewrite = scoredAtoms.filter((a) => a.score.total < 70).length

      // 4. 重写不达标的
      const rewrittenAtoms: ScoredAtom[] = await deps.rewriter.rewriteBatch(scoredAtoms)
      const afterScore = deps.scoring.scorePage(rewrittenAtoms)

      // 5. 生成 FAQ
      const faqs: FaqPair[] = await deps.faqGenerator.generate({
        atoms: rewrittenAtoms,
        workspaceId: input.workspaceId,
      })

      // 6. 计算报告指标
      const passedAtoms = rewrittenAtoms.filter((a) => a.score.total >= 70).length
      const independentAtoms = rewrittenAtoms.filter((a) => a.score.isSelfContained).length
      const coveredFaqs = faqs.filter((f) => f.matchedQueryId).length

      const result: OptimizationResult = {
        atoms: rewrittenAtoms,
        faqs,
        overallScore: afterScore,
        rewrittenCount: needsRewrite,
        report: {
          atomizationRate: rewrittenAtoms.length > 0 ? passedAtoms / rewrittenAtoms.length : 0,
          independenceRate: rewrittenAtoms.length > 0 ? independentAtoms / rewrittenAtoms.length : 0,
          faqCoverage: faqs.length > 0 ? coveredFaqs / faqs.length : 0,
        },
      }

      // 7. 更新或创建 ContentPage
      if (input.url) {
        const page = await deps.prisma.contentPage.upsert({
          where: { workspaceId_url: { workspaceId: input.workspaceId, url: input.url } },
          create: {
            workspaceId: input.workspaceId,
            url: input.url,
            pageType: input.pageType || 'landing',
            currentContent: content,
            optimizedContent: JSON.stringify(result),
            optimizationScore: afterScore,
          },
          update: {
            optimizedContent: JSON.stringify(result),
            optimizationScore: afterScore,
          },
        })
        pageId = page.id
      }

      // 8. 创建审核任务
      await deps.taskService.create({
        workspaceId: input.workspaceId,
        type: 'REWRITE_CONTENT',
        pageId,
        beforeScore,
        afterScore,
        result: {
          overallScore: result.overallScore,
          rewrittenCount: result.rewrittenCount,
          report: result.report,
        },
      })

      return result
    },
  }
}
