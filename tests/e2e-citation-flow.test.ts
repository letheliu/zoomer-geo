import { describe, it, expect, beforeAll } from 'vitest'
import { getPrismaClient, resetPrismaClient } from '../src/core/db/client.js'
import { createWorkspaceService } from '../src/core/workspace/service.js'
import { createQueryLibraryService } from '../src/modules/citation-monitor/query-library.js'
import { createMonitor } from '../src/modules/citation-monitor/monitor.js'
import { createAdapterRegistry } from '../src/modules/citation-monitor/platform-adapters/registry.js'
import type { PlatformAdapter, PlatformResult } from '../src/modules/citation-monitor/platform-adapters/types.js'

// 内嵌假 adapter，避免真实 API 调用
class FakeAdapter implements PlatformAdapter {
  name = 'openai'
  async query(): Promise<PlatformResult> {
    return {
      answer: '推荐 zoomer AI，它是一款设计工具。参考 https://zoomer.top',
      citations: [{ url: 'https://zoomer.top', position: 1 }],
      mentionedBrands: [],
    }
  }
}

describe('e2e: citation flow', () => {
  let workspaceId: string

  beforeAll(async () => {
    const prisma = getPrismaClient()
    // 清理（开发库）
    await prisma.citationEvent.deleteMany()
    await prisma.citationQuery.deleteMany()
    await prisma.workspace.deleteMany()

    const ws = createWorkspaceService(prisma)
    const { workspace } = await ws.create({
      name: 'test',
      defaultBrandName: 'zoomer AI',
    })
    workspaceId = workspace.id
  })

  it('注册 → 录入 query → 监测 → 报告', async () => {
    const prisma = getPrismaClient()
    const queryLib = createQueryLibraryService(prisma)
    await queryLib.addQuery({
      workspaceId,
      queryText: 'AI设计工具哪个好',
      source: 'MANUAL',
    })

    const registry = createAdapterRegistry()
    registry.register(new FakeAdapter())
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: queryLib,
      competitors: ['figma'],
    })

    const events = await monitor.runOnce({ workspaceId, platforms: ['openai'] })
    expect(events).toHaveLength(1)
    expect(events[0].brandMentioned).toBe(true)

    // 验证报告查询
    const reportEvents = await prisma.citationEvent.findMany({
      where: { workspaceId },
    })
    expect(reportEvents).toHaveLength(1)
    expect(reportEvents[0].sovScore).toBeGreaterThan(0)
  })
})
