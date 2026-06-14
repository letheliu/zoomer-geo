import { describe, it, expect, vi } from 'vitest'
import { createKgExtractor } from './extractor.js'
import type { PrismaClient } from '@prisma/client'
import type { EntityExtractorService } from '../../core/extract/entity-extractor.js'
import type { KgAdapterService } from '../../core/extract/adapters/kg-adapter.js'

function mockPrisma() {
  return {
    contentPage: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'page-1',
        workspaceId: 'w1',
        url: 'https://x.com/landing',
        currentContent: 'zoomer AI 是 AI 设计工具',
      }),
    },
    optimizationTask: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: 'task-1', ...data,
      })),
    },
  } as unknown as PrismaClient
}

describe('KgExtractor', () => {
  it('extractFromPage 抽取实体 + 适配 + 创建 UPDATE_KG PENDING 任务', async () => {
    const prisma = mockPrisma()
    const extractor: EntityExtractorService = {
      extract: vi.fn().mockResolvedValue({
        entities: [
          { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { url: 'https://x.com' } },
          { name: 'Notion', rawType: '笔记软件', properties: {} },
        ],
        relations: [{ fromName: 'zoomer AI', toName: 'Notion', relationType: 'competitor' }],
      }),
    }
    const adapter: KgAdapterService = {
      adapt: vi.fn().mockReturnValue([
        { name: 'zoomer AI', type: 'AI 设计工具', properties: { url: 'https://x.com' } },
        { name: 'Notion', type: '笔记软件', properties: {} },
      ]),
    }
    const kgExtractor = createKgExtractor({ prisma, extractor, kgAdapter: adapter })
    const { proposals, task } = await kgExtractor.extractFromPage('page-1')

    expect(proposals.entities).toHaveLength(2)
    expect(proposals.relations).toHaveLength(1)
    expect(task.type).toBe('UPDATE_KG')
    expect(task.status).toBe('PENDING')
    expect(task.pageId).toBe('page-1')
    expect((task as any).extractionProposals).toEqual(proposals)
    expect(prisma.optimizationTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'UPDATE_KG',
        status: 'PENDING',
        pageId: 'page-1',
      }),
    })
  })

  it('页面不存在时抛错', async () => {
    const prisma = mockPrisma()
    ;(prisma.contentPage.findUnique as any).mockResolvedValue(null)
    const extractor: EntityExtractorService = { extract: vi.fn() }
    const adapter: KgAdapterService = { adapt: vi.fn() }
    const kgExtractor = createKgExtractor({ prisma, extractor, kgAdapter: adapter })
    await expect(kgExtractor.extractFromPage('missing')).rejects.toThrow(/Page not found/)
  })
})
