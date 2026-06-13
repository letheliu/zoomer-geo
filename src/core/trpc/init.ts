import { initTRPC, TRPCError } from '@trpc/server'
import type { Workspace } from '@prisma/client'

export interface Context {
  workspace: Workspace
  services?: any
}

const t = initTRPC.context<Context>().create()

export const router = t.router
export const publicProcedure = t.procedure

// 受保护过程：要求 workspace 已解析
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.workspace) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Missing or invalid API key' })
  }
  return next({ ctx })
})
