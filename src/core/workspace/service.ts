import { createHash, randomBytes } from 'node:crypto'
import type { PrismaClient, Workspace } from '@prisma/client'

export interface CreateWorkspaceInput {
  name: string
  defaultBrandName: string
  domain?: string
  llmsTxtUrl?: string
  platformConfig?: Record<string, unknown>
}

export interface WorkspaceService {
  create(input: CreateWorkspaceInput): Promise<{ workspace: Workspace; apiKey: string }>
  findByApiKey(apiKey: string): Promise<Workspace | null>
  getById(id: string): Promise<Workspace | null>
  updatePlatformConfig(id: string, config: Record<string, unknown>): Promise<Workspace>
}

export function createWorkspaceService(prisma: PrismaClient): WorkspaceService {
  function hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex')
  }

  return {
    async create(input) {
      const apiKey = 'geo_' + randomBytes(24).toString('hex')
      const workspace = await prisma.workspace.create({
        data: {
          name: input.name,
          defaultBrandName: input.defaultBrandName,
          domain: input.domain,
          llmsTxtUrl: input.llmsTxtUrl,
          apiKeyHash: hashKey(apiKey),
          platformConfig: (input.platformConfig as any) || {},
        },
      })
      return { workspace, apiKey }
    },

    async findByApiKey(apiKey) {
      return prisma.workspace.findFirst({
        where: { apiKeyHash: hashKey(apiKey), status: 'ACTIVE' },
      })
    },

    async getById(id) {
      return prisma.workspace.findUnique({ where: { id } })
    },

    async updatePlatformConfig(id, config) {
      return prisma.workspace.update({
        where: { id },
        data: { platformConfig: config as any },
      })
    },
  }
}
