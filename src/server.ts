import 'dotenv/config'
import Fastify from 'fastify'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { appRouter } from './router.js'
import { createContext } from './core/trpc/context.js'
import { getPrismaClient } from './core/db/client.js'
import { createQueue } from './core/queue/boss.js'
import { createAdapterRegistry } from './modules/citation-monitor/platform-adapters/registry.js'
import { OpenAiAdapter } from './modules/citation-monitor/platform-adapters/openai.js'
import { PerplexityAdapter } from './modules/citation-monitor/platform-adapters/perplexity.js'
import { AnthropicAdapter } from './modules/citation-monitor/platform-adapters/anthropic.js'
import { GeminiAdapter } from './modules/citation-monitor/platform-adapters/gemini.js'
import { DeepSeekAdapter } from './modules/citation-monitor/platform-adapters/deepseek.js'
import { createQueryLibraryService } from './modules/citation-monitor/query-library.js'
import { createMonitor } from './modules/citation-monitor/monitor.js'
import { startCitationScheduler } from './workers/citation-scheduler.js'
import { getLlmProvider } from './core/llm/index.js'

async function main() {
  const port = Number(process.env.PORT || 3000)
  const prisma = getPrismaClient()

  // 组装 adapter registry
  const registry = createAdapterRegistry()
  registry.register(new OpenAiAdapter())
  registry.register(new PerplexityAdapter())
  registry.register(new AnthropicAdapter())
  registry.register(new GeminiAdapter())
  registry.register(new DeepSeekAdapter())

  const queryLibrary = createQueryLibraryService(prisma, getLlmProvider())
  const monitor = createMonitor({
    prisma,
    registry,
    queryLibrary,
    competitors: [], // 生产环境从配置加载
  })

  // 注入到 tRPC context 的 services
  const services = { prisma, monitor, queryLibrary }

  const fastify = Fastify({ logger: true })
  await fastify.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async (opts: any) => {
        const ctx = await createContext(opts)
        return { ...ctx, services } as any
      },
    },
  })

  // 启动 pg-boss + 定时任务
  const boss = await createQueue()
  await startCitationScheduler({ boss, prisma, monitor })

  await fastify.listen({ port, host: '0.0.0.0' })
  fastify.log.info(`geo-service listening on :${port}`)
}

main().catch((err) => {
  console.error('Failed to start geo-service:', err)
  process.exit(1)
})
