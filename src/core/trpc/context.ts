import { getPrismaClient } from '../db/client.js'
import { createWorkspaceService } from '../workspace/service.js'
import { resolveWorkspaceFromHeader } from '../workspace/auth.js'
import type { Context } from './init.js'

export async function createContext(
  opts: { req: { headers: Record<string, string | string[] | undefined> } },
): Promise<Partial<Context>> {
  const prisma = getPrismaClient()
  const workspaceService = createWorkspaceService(prisma)
  const apiKey = opts.req.headers['x-api-key'] as string | undefined
  const workspace = await resolveWorkspaceFromHeader(apiKey, workspaceService)
  return { workspace: workspace ?? undefined }
}
