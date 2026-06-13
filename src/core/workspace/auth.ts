import type { Workspace } from '@prisma/client'
import type { WorkspaceService } from './service.js'

export async function resolveWorkspaceFromHeader(
  apiKeyHeader: string | undefined,
  service: WorkspaceService,
): Promise<Workspace | null> {
  if (!apiKeyHeader) return null
  return service.findByApiKey(apiKeyHeader)
}
