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

const KNOWN_PLATFORMS = ['deepseek', 'doubao', 'qwen', 'ernie']

export async function startCitationScheduler(deps: SchedulerDeps): Promise<void> {
  const jobName = 'citation-monitor-daily'
  const cron = deps.cron || DEFAULT_CRON

  // pg-boss v10 要求 queue 必须先存在才能 schedule / work
  await deps.boss.createQueue(jobName)

  await deps.boss.schedule(jobName, cron, {})

  await deps.boss.work(jobName, async () => {
    const workspaces = await deps.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
    })
    for (const ws of workspaces) {
      const cfg = (ws.platformConfig as Record<string, Record<string, string>>) || {}
      const activePlatforms = KNOWN_PLATFORMS.filter((p) => {
        const keyMap: Record<string, string[]> = {
          deepseek: ['DEEPSEEK_API_KEY'],
          doubao: ['DOUBAO_API_KEY'],
          qwen: ['QWEN_API_KEY'],
          ernie: ['ERNIE_API_KEY', 'ERNIE_SECRET_KEY'],
        }
        const keys = keyMap[p] || []
        const pCfg = cfg[p] || {}
        return keys.every((k) => pCfg[k])
      })
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
