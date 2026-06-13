import { router } from './core/trpc/init.js'
import { workspaceRouter } from './core/workspace/router.js'
import { citationRouter } from './modules/citation-monitor/router.js'

export const appRouter = router({
  workspace: workspaceRouter,
  citation: citationRouter,
})

export type AppRouter = typeof appRouter
