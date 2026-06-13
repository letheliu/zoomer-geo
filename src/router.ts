import { router } from './core/trpc/init.js'
import { workspaceRouter } from './core/workspace/router.js'
import { citationRouter } from './modules/citation-monitor/router.js'
import { contentRouter } from './modules/content-optimizer/router.js'
import { taskRouter } from './modules/content-optimizer/task-router.js'

export const appRouter = router({
  workspace: workspaceRouter,
  citation: citationRouter,
  content: contentRouter,
  tasks: taskRouter,
})

export type AppRouter = typeof appRouter
