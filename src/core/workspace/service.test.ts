import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWorkspaceService } from './service.js'

function mockPrisma(overrides: Record<string, any> = {}) {
  return {
    workspace: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'ws-1',
        name: args.data.name,
        defaultBrandName: args.data.defaultBrandName,
        apiKeyHash: args.data.apiKeyHash,
        status: 'ACTIVE',
        ...overrides,
      })),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  } as any
}

describe('workspace service', () => {
  let prisma: ReturnType<typeof mockPrisma>
  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('create 生成随机 apiKey 并哈希存储', async () => {
    const svc = createWorkspaceService(prisma)
    const result = await svc.create({ name: 'zoomer', defaultBrandName: 'zoomer AI' })
    expect(result.workspace.id).toBe('ws-1')
    expect(result.apiKey).toMatch(/^geo_/)
    expect(prisma.workspace.create).toHaveBeenCalled()
    const stored = prisma.workspace.create.mock.calls[0][0].data
    expect(stored.apiKeyHash).not.toMatch(/^geo_/)
  })

  it('findByApiKey 根据 key 查找并校验', async () => {
    prisma.workspace.findFirst.mockResolvedValue({ id: 'ws-1', apiKeyHash: 'hash', status: 'ACTIVE' })
    const svc = createWorkspaceService(prisma)
    const found = await svc.findByApiKey('geo_xxx')
    expect(found?.id).toBe('ws-1')
  })

  it('SUSPENDED 的 workspace 不返回', async () => {
    prisma.workspace.findFirst.mockResolvedValue(null)
    const svc = createWorkspaceService(prisma)
    const found = await svc.findByApiKey('geo_bad')
    expect(found).toBeNull()
  })
})
