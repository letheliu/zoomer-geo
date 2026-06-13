import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

export const citationRouter = router({
  // 手动触发单次监测
  trackQuery: protectedProcedure
    .input(z.object({
      query: z.string(),
      brand: z.string().optional(),
      platforms: z.array(z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const events = await ctx.services.monitor.runOnce({
        workspaceId: ctx.workspace.id,
        platforms: input.platforms,
      })
      return { events }
    }),

  // 批量监测
  batchTrack: protectedProcedure
    .input(z.object({
      queries: z.array(z.string()),
      platforms: z.array(z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const events = await ctx.services.monitor.runOnce({
        workspaceId: ctx.workspace.id,
        platforms: input.platforms,
      })
      return { events }
    }),

  // 查询报告
  getReport: protectedProcedure
    .input(z.object({
      dateRange: z.object({ start: z.string(), end: z.string() }),
      platform: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const where: any = {
        workspaceId: ctx.workspace.id,
        capturedAt: {
          gte: new Date(input.dateRange.start),
          lte: new Date(input.dateRange.end),
        },
      }
      if (input.platform) where.platform = input.platform
      const events = await ctx.services.prisma.citationEvent.findMany({ where })
      return { events }
    }),

  // SOV 分数
  getSovScore: protectedProcedure
    .input(z.object({
      competitors: z.array(z.string()),
      dateRange: z.object({ start: z.string(), end: z.string() }),
    }))
    .query(async ({ ctx, input }) => {
      const events = await ctx.services.prisma.citationEvent.findMany({
        where: {
          workspaceId: ctx.workspace.id,
          capturedAt: {
            gte: new Date(input.dateRange.start),
            lte: new Date(input.dateRange.end),
          },
        },
      })
      const mentioned = events.filter((e: any) => e.brandMentioned).length
      const sovScore = events.length > 0 ? mentioned / events.length : 0
      return { sovScore, totalEvents: events.length, mentionedCount: mentioned }
    }),

  // query 库管理
  queries: router({
    list: protectedProcedure
      .input(z.object({ status: z.enum(['active', 'paused']).optional() }).optional())
      .query(async ({ ctx }) => {
        return ctx.services.queryLibrary.listActive(ctx.workspace.id)
      }),

    add: protectedProcedure
      .input(z.object({
        queryText: z.string(),
        source: z.enum(['manual', 'google_suggest', 'llm_generated', 'paa', 'competitor']),
        intent: z.record(z.unknown()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.addQuery({
          workspaceId: ctx.workspace.id,
          queryText: input.queryText,
          source: input.source.toUpperCase() as any,
          intent: input.intent,
        })
      }),

    generate: protectedProcedure
      .input(z.object({
        topic: z.string(),
        count: z.number().min(1).max(100),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.generateQueries({
          workspaceId: ctx.workspace.id,
          topic: input.topic,
          count: input.count,
        })
      }),
  }),
})
