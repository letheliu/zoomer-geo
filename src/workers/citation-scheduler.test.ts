import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startCitationScheduler } from './citation-scheduler.js'

describe('citation scheduler', () => {
  let boss: any
  let deps: any

  beforeEach(() => {
    boss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    }
    deps = {
      boss,
      prisma: {
        workspace: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'w1', status: 'ACTIVE', platformConfig: { openai: {} } },
            { id: 'w2', status: 'ACTIVE', platformConfig: { openai: {} } },
          ]),
        },
      },
      monitor: {
        runOnce: vi.fn().mockResolvedValue([{ id: 'ev1' }]),
      },
    }
  })

  it('注册定时任务并订阅 work handler', async () => {
    await startCitationScheduler(deps)
    expect(boss.schedule).toHaveBeenCalledWith(
      'citation-monitor-daily',
      expect.anything(),
      expect.anything(),
    )
    expect(boss.work).toHaveBeenCalledWith(
      'citation-monitor-daily',
      expect.any(Function),
    )
  })

  it('work handler 遍历所有 ACTIVE workspace', async () => {
    await startCitationScheduler(deps)
    const handler = boss.work.mock.calls[0][1]
    await handler({ data: { platforms: ['openai'] } })
    expect(deps.monitor.runOnce).toHaveBeenCalledTimes(2)
    expect(deps.monitor.runOnce).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1' }),
    )
  })
})
