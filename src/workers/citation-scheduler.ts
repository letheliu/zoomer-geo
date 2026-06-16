import type PgBoss from 'pg-boss'
import type { PrismaClient } from '@prisma/client'
import type { Monitor } from '../modules/citation-monitor/monitor.js'

export interface SchedulerDeps {
  boss: PgBoss
  prisma: PrismaClient
  monitor: Monitor
  cron?: string
}

const DEFAULT_CRON = '0 2 * * *' // 每日 02:00

export async function startCitationScheduler(deps: SchedulerDeps): Promise<void> {
  const jobName = 'citation-monitor-daily'
  const cron = deps.cron || DEFAULT_CRON

  // pg-boss v10 要求 queue 必须先存在才能 schedule / work
  await deps.boss.createQueue(jobName)

  await deps.boss.schedule(jobName, cron, { platforms: ['openai', 'perplexity'] })

  await deps.boss.work(jobName, async (job: any) => {
    const platforms: string[] = job.data?.platforms || ['openai']
    const workspaces = await deps.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
    })
    for (const ws of workspaces) {
      const configured = Object.keys((ws.platformConfig as any) || {})
      const activePlatforms = platforms.filter((p) => configured.includes(p))
      if (activePlatforms.length === 0) continue
      try {
        await deps.monitor.runOnce({
          workspaceId: ws.id,
          platforms: activePlatforms,
        })
      } catch (err) {
        console.error(`[scheduler] workspace=${ws.id} failed:`, err)
      }
    }
  })
}
