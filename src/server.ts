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
import { createAtomizer } from './modules/content-optimizer/atomizer.js'
import { createScoringEngine } from './modules/content-optimizer/scoring.js'
import { createRewriter } from './modules/content-optimizer/rewriter.js'
import { createFaqGenerator } from './modules/content-optimizer/faq-generator.js'
import { createTaskService } from './modules/content-optimizer/task-service.js'
import { createOrchestrator } from './modules/content-optimizer/orchestrator.js'
import { createEntityExtractor } from './core/extract/entity-extractor.js'
import { createSchemaAdapter } from './core/extract/adapters/schema-adapter.js'
import { createKgAdapter } from './core/extract/adapters/kg-adapter.js'
import { createSchemaRegistry } from './modules/schema-generator/schema-registry.js'
import { createJsonLdBuilder } from './modules/schema-generator/jsonld-builder.js'
import { createLlmsTxtBuilder } from './modules/schema-generator/llms-txt-builder.js'
import { createSchemaValidator } from './modules/schema-generator/validator.js'
import { createAutoSections } from './modules/schema-generator/auto-sections.js'
import { createSchemaService } from './modules/schema-generator/service.js'
import { createKgRepository } from './modules/knowledge-graph/repository.js'
import { createKgExtractor } from './modules/knowledge-graph/extractor.js'
import { createGraphExporter } from './modules/knowledge-graph/exporter.js'
import { createKgService } from './modules/knowledge-graph/service.js'

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

  // 组装 content-optimizer 组件
  const atomizer = createAtomizer(getLlmProvider())
  const scoring = createScoringEngine()
  const rewriter = createRewriter(getLlmProvider())
  const faqGenerator = createFaqGenerator(getLlmProvider(), prisma)

  // 共享层
  const entityExtractor = createEntityExtractor(getLlmProvider())
  const schemaRegistry = createSchemaRegistry()
  const schemaAdapter = createSchemaAdapter(schemaRegistry)
  const kgAdapter = createKgAdapter()

  // Schema Generator
  const jsonLdBuilder = createJsonLdBuilder()
  const llmsTxtBuilder = createLlmsTxtBuilder()
  const validator = createSchemaValidator(schemaRegistry)
  const autoSections = createAutoSections({ prisma })
  const schemaService = createSchemaService({
    prisma, extractor: entityExtractor, schemaAdapter,
    jsonLdBuilder, llmsTxtBuilder, validator, autoSections, schemaRegistry,
  })

  // Knowledge Graph
  const kgRepository = createKgRepository(prisma)
  const kgExtractorService = createKgExtractor({ prisma, extractor: entityExtractor, kgAdapter })
  const kgExporter = createGraphExporter(prisma)
  const kgService = createKgService({
    prisma, repository: kgRepository, extractor: kgExtractorService, exporter: kgExporter,
  })

  // taskService 增加回调钩子（驱动阶段 3 联动）
  const taskService = createTaskService({
    prisma,
    onPublished: async (task) => {
      // 内容类任务发布后自动重新生成 Schema
      if (task.pageId && (task.type === 'REWRITE_CONTENT' || task.type === 'OPTIMIZE_FOR_QUERY')) {
        try {
          await schemaService.regenerateForPage(task.pageId)
        } catch (err) {
          console.error('[onPublished] schemaService.regenerateForPage failed:', err)
        }
      }
      // UPDATE_KG 任务发布后持久化提案
      if (task.extractionProposals) {
        try {
          const proposals = task.extractionProposals as any
          await kgService.persistProposals(task.workspaceId, proposals)
        } catch (err) {
          console.error('[onPublished] kgService.persistProposals failed:', err)
        }
      }
    },
  })

  const orchestrator = createOrchestrator({
    atomizer, scoring, rewriter, faqGenerator, taskService, prisma,
  })

  // 注入到 tRPC context 的 services
  const services = {
    prisma, monitor, queryLibrary,
    orchestrator, taskService, atomizer, faqGenerator,
    schema: schemaService,
    kg: kgService,
  }

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
