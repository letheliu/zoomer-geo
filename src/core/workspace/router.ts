import { z } from 'zod'
import { router, publicProcedure, protectedProcedure } from '../trpc/init.js'
import { getPrismaClient } from '../db/client.js'
import { createWorkspaceService } from './service.js'

export const workspaceRouter = router({
  // 获取当前 workspace 信息
  get: protectedProcedure
    .query(async ({ ctx }) => {
      return ctx.workspace
    }),

  // 注册新 workspace（仅引导阶段开放，生产应加管理员鉴权）
  register: publicProcedure
    .input(z.object({
      name: z.string(),
      defaultBrandName: z.string(),
      domain: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const prisma = getPrismaClient()
      const svc = createWorkspaceService(prisma)
      const { workspace, apiKey } = await svc.create(input)
      return { workspaceId: workspace.id, apiKey }
    }),

  // 配置各 AI 平台凭证
  setPlatformConfig: publicProcedure
    .input(z.object({
      apiKey: z.string(),
      config: z.record(z.unknown()),
    }))
    .mutation(async ({ input }) => {
      const prisma = getPrismaClient()
      const svc = createWorkspaceService(prisma)
      const ws = await svc.findByApiKey(input.apiKey)
      if (!ws) throw new Error('Invalid API key')
      await svc.updatePlatformConfig(ws.id, input.config)
      return { ok: true }
    }),
})
