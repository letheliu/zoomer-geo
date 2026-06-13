import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch'
import { getPrismaClient } from '../db/client.js'
import { createWorkspaceService } from '../workspace/service.js'
import { resolveWorkspaceFromHeader } from '../workspace/auth.js'
import type { Context } from './init.js'

export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<Partial<Context>> {
  const prisma = getPrismaClient()
  const workspaceService = createWorkspaceService(prisma)
  const apiKey = opts.req.headers.get('x-api-key') || undefined
  const workspace = await resolveWorkspaceFromHeader(apiKey, workspaceService)
  return { workspace: workspace ?? undefined }
}
