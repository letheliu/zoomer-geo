# GEO 优化增强实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将现有 GEO Console 从 MVP 闭环升级为可记录真实 citation/grounding、可发布到外部目标、可做优化前后回测、并能约束 LLM 事实幻觉的生产级闭环。

**架构：** 在现有 Fastify + tRPC + Prisma 单体服务中增量增强四个边界：Citation Monitor 输出结构化 source citation，Metrics Service 聚合回测指标，Publisher 模块负责外部发布记录，Content Optimizer 增加 evidence/事实新增策略。现有模块接口保持兼容，旧数据通过 fallback 字段读取。

**技术栈：** TypeScript / Node.js、tRPC 10、Prisma 5、Vitest、PostgreSQL、现有 LlmProvider、现有 pg-boss。

**规格依据：** `docs/superpowers/specs/2026-06-22-geo-optimization-hardening-design.md`

**范围边界：** 不实现真实 GSC/Bing 提交，不执行 git push，不新增真实 CMS 插件，不做黑帽 GEO。

---

## 文件结构

新增或修改文件如下：

```
prisma/schema.prisma

src/modules/citation-monitor/
├── platform-adapters/types.ts            # 扩展 PlatformResult / SourceCitation / BrandMention
├── platform-adapters/openai.ts           # 读取结构化 citation 字段，保留 URL fallback
├── platform-adapters/perplexity.ts       # 使用 API citations 输出 sourceCitations
├── platform-adapters/gemini.ts           # 读取 grounding metadata，保留 URL fallback
├── platform-adapters/anthropic.ts        # 读取 web search citation/tool metadata，保留 URL fallback
├── analyzer.ts                           # 计算 brandSourceCited / sourceRank / 加权 SOV
├── metrics.ts                            # 新增：指标聚合与 before/after 对比
├── monitor.ts                            # 写入新增 CitationEvent 字段
├── query-library.ts                      # 支持结构化 query draft 与新字段
├── router.ts                             # 接入 metrics 和 query 新字段
└── *.test.ts

src/modules/content-optimizer/
├── types.ts                              # 增加 Evidence / RewriteOptions
├── rewriter.ts                           # 改写 prompt 支持事实新增策略
├── orchestrator.ts                       # 传递 rewriteOptions，保留兼容默认值
├── task-service.ts                       # publish 接入 publisher 回调结果
└── *.test.ts

src/modules/schema-generator/
├── auto-sections.ts                      # 支持 publishedOnly，优先已发布页面
├── service.ts                            # generateLlmsTxt 支持 publishedOnly 来源
└── *.test.ts

src/modules/publisher/
├── types.ts
├── registry.ts
├── service.ts
├── router.ts
├── adapters/webhook.ts
├── adapters/file-export.ts
├── adapters/git-patch.ts
└── *.test.ts

src/server.ts                             # 组装 publisher 服务
src/router.ts                             # 注册 publisher router
src/core/trpc/context.ts                  # services 类型包含 publisher
web/src/views/citation/EffectComparison.vue # 适配新回测字段
web/src/views/content/Tasks.vue             # 展示发布结果摘要
web/src/views/Settings.vue                  # publicationConfig 基础配置
```

---

## 约定

- 每个任务先写测试，再实现。
- 单元测试优先 mock PrismaClient 和 fetch，不依赖真实 DB 或真实外部平台。
- 数据库 schema 修改后运行 `pnpm db:generate`。
- 每个任务完成后运行对应测试；阶段完成后运行 `pnpm test` 和 `pnpm build`。
- 如果当前环境没有依赖，先运行 `pnpm install`；如果网络受限，记录验证失败原因，不通过绕过方式安装。

---

## 任务 1：Prisma 数据模型扩展

**文件：**
- 修改：`prisma/schema.prisma`

- [ ] **步骤 1：扩展 `CitationEvent`**

在 `CitationEvent` 中追加字段：

```prisma
  brandSourceCited Boolean @default(false)
  sourceRank       Int?
  sourceCitations  Json    @default("[]")
  groundingSources Json    @default("[]")
  analysis         Json    @default("{}")
```

保留 `citedUrls` 字段，用于兼容旧事件。

- [ ] **步骤 2：扩展 `CitationQuery`**

在 `CitationQuery` 中追加字段：

```prisma
  intentType    String?
  cluster       String?
  mappedPageUrl String?
  priority      Int       @default(3)
  lastRunAt     DateTime?
```

- [ ] **步骤 3：扩展 `ContentPage`**

在 `ContentPage` 中追加字段：

```prisma
  publishedContent String?
  lastPublishedAt  DateTime?
```

- [ ] **步骤 4：扩展 `Workspace`**

在 `Workspace` 中追加字段：

```prisma
  publicationConfig  Json                @default("{}")
  publicationRecords PublicationRecord[]
```

- [ ] **步骤 5：新增 `PublicationRecord` 和 `PublicationStatus`**

在模型区追加：

```prisma
model PublicationRecord {
  id          String            @id @default(cuid())
  workspaceId String
  taskId      String?
  pageUrl     String
  targetType  String
  status      PublicationStatus @default(PENDING)
  payload     Json
  response    Json?
  error       String?
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt
  workspace   Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, status])
  @@index([workspaceId, pageUrl])
}

enum PublicationStatus {
  PENDING
  SUCCEEDED
  FAILED
}
```

- [ ] **步骤 6：生成 Prisma Client**

运行：`pnpm db:generate`

预期：Prisma Client 生成成功，无 schema 解析错误。

- [ ] **步骤 7：Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): add GEO hardening fields and publication records"
```

---

## 任务 2：统一平台 citation 类型

**文件：**
- 修改：`src/modules/citation-monitor/platform-adapters/types.ts`
- 测试：`src/modules/citation-monitor/platform-adapters/types.test.ts`

- [ ] **步骤 1：编写类型兼容测试**

创建测试，验证旧结果可通过 helper 归一化：

```typescript
import { normalizePlatformResult } from './types.js'

describe('normalizePlatformResult', () => {
  it('兼容旧 citations 字段并转为 sourceCitations', () => {
    const result = normalizePlatformResult({
      answer: '参考 https://example.com',
      citations: [{ url: 'https://example.com', position: 1 }],
      mentionedBrands: [],
    } as any)

    expect(result.sourceCitations[0]).toMatchObject({
      url: 'https://example.com',
      position: 1,
      sourceType: 'answer_url',
    })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/modules/citation-monitor/platform-adapters/types.test.ts`

预期：FAIL，提示 `normalizePlatformResult` 不存在。

- [ ] **步骤 3：实现类型和归一化 helper**

在 `types.ts` 中定义：

```typescript
export interface SourceCitation {
  url: string
  title?: string
  snippet?: string
  position: number
  sourceType: 'api_citation' | 'grounding' | 'answer_url'
  providerMetadata?: Record<string, unknown>
}

export interface BrandMention {
  brand: string
  mentioned: boolean
  firstIndex: number | null
  count: number
}

export interface PlatformResult {
  answer: string
  sourceCitations: SourceCitation[]
  groundingSources: SourceCitation[]
  answerMentions: BrandMention[]
  raw?: unknown
}

export function normalizePlatformResult(input: PlatformResult | any): PlatformResult {
  if (Array.isArray(input.sourceCitations)) {
    return {
      answer: input.answer ?? '',
      sourceCitations: input.sourceCitations,
      groundingSources: input.groundingSources ?? [],
      answerMentions: input.answerMentions ?? [],
      raw: input.raw,
    }
  }

  return {
    answer: input.answer ?? '',
    sourceCitations: (input.citations ?? []).map((c: any, i: number) => ({
      url: String(c.url),
      position: Number(c.position ?? i + 1),
      snippet: c.snippet,
      sourceType: 'answer_url' as const,
    })),
    groundingSources: [],
    answerMentions: [],
    raw: input.raw,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/modules/citation-monitor/platform-adapters/types.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/platform-adapters/types.ts src/modules/citation-monitor/platform-adapters/types.test.ts
git commit -m "feat(citation): add normalized source citation result types"
```

---

## 任务 3：增强 Citation Analyzer

**文件：**
- 修改：`src/modules/citation-monitor/analyzer.ts`
- 测试：`src/modules/citation-monitor/analyzer.test.ts`

- [ ] **步骤 1：新增 analyzer 测试**

在现有测试中补充：

```typescript
it('识别品牌来源引用并计算 sourceRank', () => {
  const result = analyzeCitation({
    platformResult: {
      answer: 'Notion 和 zoomer AI 都可以考虑',
      sourceCitations: [
        { url: 'https://notion.so', position: 1, sourceType: 'api_citation' },
        { url: 'https://zoomer.top/features', position: 2, sourceType: 'api_citation' },
      ],
      groundingSources: [],
      answerMentions: [],
    },
    brand: 'zoomer AI',
    brandDomains: ['zoomer.top'],
    competitors: ['Notion'],
  })

  expect(result.brandMentioned).toBe(true)
  expect(result.brandSourceCited).toBe(true)
  expect(result.sourceRank).toBe(2)
  expect(result.sourceCitationRate).toBe(0.5)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/modules/citation-monitor/analyzer.test.ts`

预期：FAIL，提示新字段或 `brandDomains` 不存在。

- [ ] **步骤 3：实现分析逻辑**

更新 `AnalyzeInput`：

```typescript
export interface AnalyzeInput {
  platformResult: PlatformResult
  brand: string
  brandDomains?: string[]
  competitors: string[]
}
```

新增 helper：

```typescript
function urlMatchesDomains(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return domains.some((d) => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
}
```

更新返回字段：

```typescript
return {
  brandMentioned,
  brandSourceCited,
  rankInAnswer,
  sourceRank,
  sovScore,
  sourceCitationRate,
  competitors: competitorResult,
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/modules/citation-monitor/analyzer.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/analyzer.ts src/modules/citation-monitor/analyzer.test.ts
git commit -m "feat(citation): analyze source citations and domain matches"
```

---

## 任务 4：升级平台适配器输出

**文件：**
- 修改：`src/modules/citation-monitor/platform-adapters/openai.ts`
- 修改：`src/modules/citation-monitor/platform-adapters/perplexity.ts`
- 修改：`src/modules/citation-monitor/platform-adapters/gemini.ts`
- 修改：`src/modules/citation-monitor/platform-adapters/anthropic.ts`
- 测试：对应 `*.test.ts`

- [ ] **步骤 1：补充 Perplexity 测试**

验证 `json.citations` 输出为 `sourceType: 'api_citation'`：

```typescript
expect(result.sourceCitations[0]).toMatchObject({
  url: 'https://zoomer.top',
  position: 1,
  sourceType: 'api_citation',
})
```

- [ ] **步骤 2：补充 Gemini grounding 测试**

mock 返回：

```typescript
{
  candidates: [{
    content: { parts: [{ text: 'zoomer AI 可以用于设计协作' }] },
    groundingMetadata: {
      groundingChunks: [{
        web: { uri: 'https://zoomer.top', title: 'Zoomer' }
      }]
    }
  }]
}
```

断言 `groundingSources[0].sourceType === 'grounding'`。

- [ ] **步骤 3：补充 OpenAI / Anthropic fallback 测试**

当响应没有结构化 citation 字段但答案中含 URL 时，断言输出 `sourceType: 'answer_url'`。

- [ ] **步骤 4：运行测试验证失败**

运行：

```bash
pnpm exec vitest run \
  src/modules/citation-monitor/platform-adapters/perplexity.test.ts \
  src/modules/citation-monitor/platform-adapters/gemini.test.ts \
  src/modules/citation-monitor/platform-adapters/openai.test.ts \
  src/modules/citation-monitor/platform-adapters/anthropic.test.ts
```

预期：FAIL，旧字段断言或新字段缺失。

- [ ] **步骤 5：实现适配器输出**

每个 adapter 返回：

```typescript
return {
  answer,
  sourceCitations,
  groundingSources,
  answerMentions: [],
  raw: json,
}
```

URL fallback 使用统一 helper：

```typescript
function extractAnswerUrlCitations(answer: string): SourceCitation[] {
  return [...answer.matchAll(URL_REGEX)].map((m, i) => ({
    url: m[0],
    position: i + 1,
    sourceType: 'answer_url' as const,
  }))
}
```

- [ ] **步骤 6：运行测试验证通过**

运行同步骤 4 命令。

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/modules/citation-monitor/platform-adapters
git commit -m "feat(citation): emit structured source citations from adapters"
```

---

## 任务 5：Monitor 写入新增事件字段

**文件：**
- 修改：`src/modules/citation-monitor/monitor.ts`
- 测试：`src/modules/citation-monitor/monitor.test.ts`
- 测试：`tests/e2e-citation-flow.test.ts`

- [ ] **步骤 1：新增 monitor 测试断言**

在 mock adapter 返回 source citation 后，断言 Prisma create data 包含：

```typescript
expect(prisma.citationEvent.create).toHaveBeenCalledWith({
  data: expect.objectContaining({
    brandSourceCited: true,
    sourceRank: 1,
    sourceCitations: expect.any(Array),
    groundingSources: [],
    analysis: expect.any(Object),
  }),
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/modules/citation-monitor/monitor.test.ts tests/e2e-citation-flow.test.ts`

预期：FAIL，create data 缺少新增字段。

- [ ] **步骤 3：更新 monitor**

调用 analyzer 时传入 workspace domain：

```typescript
const brandDomains = [workspace.domain].filter(Boolean) as string[]
```

创建事件时写入：

```typescript
brandSourceCited: analysis.brandSourceCited,
sourceRank: analysis.sourceRank,
sourceCitations: platformResult.sourceCitations as any,
groundingSources: platformResult.groundingSources as any,
analysis: analysis as any,
```

同时保留：

```typescript
citedUrls: platformResult.sourceCitations as any,
```

- [ ] **步骤 4：运行测试验证通过**

运行同步骤 2 命令。

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/monitor.ts src/modules/citation-monitor/monitor.test.ts tests/e2e-citation-flow.test.ts
git commit -m "feat(citation): persist source citation analysis"
```

---

## 任务 6：Query Library 结构化 query

**文件：**
- 修改：`src/modules/citation-monitor/query-library.ts`
- 修改：`src/modules/citation-monitor/router.ts`
- 测试：`src/modules/citation-monitor/query-library.test.ts`
- 测试：`src/modules/citation-monitor/router.test.ts`

- [ ] **步骤 1：新增 query-library 测试**

覆盖结构化 LLM 输出：

```typescript
const llm = mockLlm(JSON.stringify([
  {
    queryText: 'AI 设计工具哪个好',
    intentType: 'comparison',
    cluster: 'ai-design-tools',
    mappedPageUrl: 'https://zoomer.top/features',
    priority: 1
  }
]))

const created = await service.generateQueries({ workspaceId: 'w1', topic: 'AI 设计工具', count: 1 })

expect(prisma.citationQuery.create).toHaveBeenCalledWith({
  data: expect.objectContaining({
    intentType: 'comparison',
    cluster: 'ai-design-tools',
    mappedPageUrl: 'https://zoomer.top/features',
    priority: 1,
  }),
})
```

- [ ] **步骤 2：新增字符串数组兼容测试**

LLM 返回 `["AI 设计工具推荐"]` 时，断言 `intentType: 'other'`、`priority: 3`。

- [ ] **步骤 3：运行测试验证失败**

运行：`pnpm exec vitest run src/modules/citation-monitor/query-library.test.ts src/modules/citation-monitor/router.test.ts`

预期：FAIL，新字段未写入。

- [ ] **步骤 4：实现结构化 query parser**

新增：

```typescript
interface GeneratedQueryDraft {
  queryText: string
  intentType: string
  cluster?: string
  mappedPageUrl?: string
  priority: number
}
```

将旧字符串转为：

```typescript
{
  queryText: q,
  intentType: 'other',
  priority: 3,
}
```

- [ ] **步骤 5：更新 router input**

`queries.add` 支持：

```typescript
intentType: z.string().optional(),
cluster: z.string().optional(),
mappedPageUrl: z.string().url().optional(),
priority: z.number().int().min(1).max(5).optional(),
```

- [ ] **步骤 6：运行测试验证通过**

运行同步骤 3 命令。

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/modules/citation-monitor/query-library.ts src/modules/citation-monitor/router.ts src/modules/citation-monitor/query-library.test.ts src/modules/citation-monitor/router.test.ts
git commit -m "feat(citation): add structured query metadata"
```

---

## 任务 7：新增 Metrics Service

**文件：**
- 创建：`src/modules/citation-monitor/metrics.ts`
- 创建：`src/modules/citation-monitor/metrics.test.ts`
- 修改：`src/modules/citation-monitor/router.ts`
- 测试：`src/modules/citation-monitor/router.test.ts`

- [ ] **步骤 1：编写 metrics 测试**

```typescript
import { compareGeoMetrics } from './metrics.js'

it('计算 before/after 的 source citation delta', () => {
  const before = [
    { brandMentioned: true, brandSourceCited: false, rankInAnswer: 2, sourceRank: null, sovScore: 0.2 },
  ] as any[]
  const after = [
    { brandMentioned: true, brandSourceCited: true, rankInAnswer: 1, sourceRank: 1, sovScore: 0.8 },
  ] as any[]

  const result = compareGeoMetrics(before, after)

  expect(result.before.sourceCitationRate).toBe(0)
  expect(result.after.sourceCitationRate).toBe(1)
  expect(result.delta.sourceCitationRate).toBe(1)
  expect(result.delta.avgSovScore).toBeCloseTo(0.6)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/modules/citation-monitor/metrics.test.ts`

预期：FAIL，文件不存在。

- [ ] **步骤 3：实现 metrics**

实现：

```typescript
export function summarizeGeoMetrics(events: CitationMetricEvent[]): GeoMetricsSnapshot
export function compareGeoMetrics(before: CitationMetricEvent[], after: CitationMetricEvent[]): GeoEffectComparison
```

平均 rank 只统计非 null 值；空样本返回 `0` 或 `null`。

- [ ] **步骤 4：更新 router**

`getSovScore` 和 `getEffectComparison` 调用 metrics helper，返回：

```typescript
{
  before,
  after,
  delta,
}
```

保留旧字段兼容：

```typescript
legacy: { totalEvents, mentionedCount, sovScore }
```

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
pnpm exec vitest run src/modules/citation-monitor/metrics.test.ts src/modules/citation-monitor/router.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/modules/citation-monitor/metrics.ts src/modules/citation-monitor/metrics.test.ts src/modules/citation-monitor/router.ts src/modules/citation-monitor/router.test.ts
git commit -m "feat(citation): add GEO metric comparison service"
```

---

## 任务 8：Publisher 类型、注册表与适配器

**文件：**
- 创建：`src/modules/publisher/types.ts`
- 创建：`src/modules/publisher/registry.ts`
- 创建：`src/modules/publisher/adapters/webhook.ts`
- 创建：`src/modules/publisher/adapters/file-export.ts`
- 创建：`src/modules/publisher/adapters/git-patch.ts`
- 测试：对应 `*.test.ts`

- [ ] **步骤 1：编写 registry 测试**

```typescript
const registry = createPublisherRegistry()
registry.register({ type: 'webhook', publish: vi.fn() })
expect(registry.get('webhook')?.type).toBe('webhook')
expect(registry.list()).toContain('webhook')
```

- [ ] **步骤 2：编写 file-export adapter 测试**

输入 publication payload 后，断言返回：

```typescript
expect(result.status).toBe('SUCCEEDED')
expect(result.response).toMatchObject({
  files: expect.arrayContaining([
    expect.objectContaining({ path: '/llms.txt' }),
  ]),
})
```

- [ ] **步骤 3：编写 git-patch adapter 测试**

断言只生成 patch payload，不执行 git 命令：

```typescript
expect(result.response.patch).toContain('diff --git')
```

- [ ] **步骤 4：运行测试验证失败**

运行：`pnpm exec vitest run src/modules/publisher`

预期：FAIL，模块不存在。

- [ ] **步骤 5：实现类型**

`types.ts`：

```typescript
export type PublicationTargetType = 'webhook' | 'file_export' | 'git_patch'

export interface PublicationPayload {
  workspaceId: string
  taskId?: string
  pageUrl: string
  optimizedContent?: string
  jsonLd?: unknown[]
  llmsTxt?: string
}

export interface PublicationResult {
  status: 'SUCCEEDED' | 'FAILED'
  response?: Record<string, unknown>
  error?: string
}

export interface PublisherAdapter {
  type: PublicationTargetType
  publish(payload: PublicationPayload, config: Record<string, unknown>): Promise<PublicationResult>
}
```

- [ ] **步骤 6：实现 registry 和三种 adapter**

`webhook` 用 fetch POST；`file_export` 返回文件数组；`git_patch` 返回 patch 字符串。所有 adapter 捕获错误并返回 `FAILED`。

- [ ] **步骤 7：运行测试验证通过**

运行：`pnpm exec vitest run src/modules/publisher`

预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add src/modules/publisher
git commit -m "feat(publisher): add publication adapters and registry"
```

---

## 任务 9：Publisher Service、Router 与发布记录

**文件：**
- 创建：`src/modules/publisher/service.ts`
- 创建：`src/modules/publisher/router.ts`
- 创建：`src/modules/publisher/service.test.ts`
- 创建：`src/modules/publisher/router.test.ts`
- 修改：`src/router.ts`
- 修改：`src/server.ts`
- 修改：`src/core/trpc/context.ts`

- [ ] **步骤 1：编写 service 成功/失败测试**

成功时断言 `publicationRecord.create` 写入 `SUCCEEDED`；adapter 失败时写入 `FAILED` 和 error。

- [ ] **步骤 2：编写 router 测试**

覆盖：

```typescript
caller.publisher.records.list()
caller.publisher.records.get({ id: 'pub-1' })
caller.publisher.retry({ id: 'pub-1' })
```

- [ ] **步骤 3：运行测试验证失败**

运行：`pnpm exec vitest run src/modules/publisher/service.test.ts src/modules/publisher/router.test.ts`

预期：FAIL，service/router 不存在。

- [ ] **步骤 4：实现 service**

核心方法：

```typescript
publish(input: {
  workspaceId: string
  taskId?: string
  pageUrl: string
  targetType: PublicationTargetType
  payload: PublicationPayload
}): Promise<PublicationRecord>
```

从 workspace `publicationConfig[targetType]` 读取配置。

- [ ] **步骤 5：实现 router 并注册**

`src/router.ts` 增加：

```typescript
publisher: publisherRouter,
```

`server.ts` 中创建 registry、注册 adapter、创建 publisher service。

- [ ] **步骤 6：运行测试验证通过**

运行同步骤 3 命令。

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/modules/publisher src/router.ts src/server.ts src/core/trpc/context.ts
git commit -m "feat(publisher): persist publication results and expose router"
```

---

## 任务 10：内容事实证据与改写策略

**文件：**
- 修改：`src/modules/content-optimizer/types.ts`
- 修改：`src/modules/content-optimizer/rewriter.ts`
- 修改：`src/modules/content-optimizer/orchestrator.ts`
- 测试：`src/modules/content-optimizer/rewriter.test.ts`
- 测试：`src/modules/content-optimizer/orchestrator.test.ts`

- [ ] **步骤 1：新增 rewriter 测试**

断言默认 prompt 不允许新增无来源事实：

```typescript
await rewriter.rewrite(atom, score)
expect(llm.chat).toHaveBeenCalledWith(
  expect.arrayContaining([
    expect.objectContaining({
      content: expect.stringContaining('不要新增原文中不存在的数字、统计或第三方事实'),
    }),
  ]),
  expect.any(Object),
)
```

- [ ] **步骤 2：新增 evidence 解析测试**

LLM 返回：

```json
{"text":"...","subject":"...","predicate":"...","object":"...","anchors":["2026"],"evidence":[{"sourceType":"manual","confidence":0.8}]}
```

断言 rewritten atom 带 evidence。

- [ ] **步骤 3：运行测试验证失败**

运行：`pnpm exec vitest run src/modules/content-optimizer/rewriter.test.ts src/modules/content-optimizer/orchestrator.test.ts`

预期：FAIL，Evidence 类型和 options 不存在。

- [ ] **步骤 4：扩展类型**

在 `types.ts` 增加：

```typescript
export interface Evidence {
  sourceUrl?: string
  sourceTitle?: string
  sourceType: 'user_input' | 'existing_page' | 'citation_source' | 'manual' | 'unknown'
  confidence: number
}

export interface RewriteOptions {
  allowNewFacts: boolean
  requiredEvidenceForNewFacts: boolean
}
```

`Atom` 增加 `evidence?: Evidence[]`。

- [ ] **步骤 5：更新 rewriter**

`rewrite` 和 `rewriteBatch` 接收 `RewriteOptions`，默认：

```typescript
const DEFAULT_REWRITE_OPTIONS = {
  allowNewFacts: false,
  requiredEvidenceForNewFacts: true,
}
```

- [ ] **步骤 6：更新 orchestrator**

`OptimizeInput` 增加：

```typescript
rewriteOptions?: Partial<RewriteOptions>
```

调用 `rewriteBatch(scoredAtoms, 70, mergedRewriteOptions)`。

- [ ] **步骤 7：运行测试验证通过**

运行同步骤 3 命令。

预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add src/modules/content-optimizer/types.ts src/modules/content-optimizer/rewriter.ts src/modules/content-optimizer/orchestrator.ts src/modules/content-optimizer/*.test.ts
git commit -m "feat(content): require evidence-aware rewrite options"
```

---

## 任务 11：发布时组装优化内容、Schema 和 llms.txt

**文件：**
- 修改：`src/modules/content-optimizer/task-service.ts`
- 修改：`src/modules/schema-generator/auto-sections.ts`
- 修改：`src/modules/schema-generator/service.ts`
- 测试：`src/modules/content-optimizer/task-service.test.ts`
- 测试：`src/modules/schema-generator/auto-sections.test.ts`
- 测试：`src/modules/schema-generator/service.test.ts`

- [ ] **步骤 1：新增 publish 回调测试**

当 task 发布且 workspace 配置 publisher 时，断言 publisher 被调用；失败时 task 状态仍为 `PUBLISHED`，但错误记录由 publisher service 处理。

- [ ] **步骤 2：新增 autoSections publishedOnly 测试**

插入 DRAFT 和 PUBLISHED 页面 mock，调用：

```typescript
autoSections.buildSections('w1', { publishedOnly: true })
```

断言只包含 PUBLISHED 页面。

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
pnpm exec vitest run \
  src/modules/content-optimizer/task-service.test.ts \
  src/modules/schema-generator/auto-sections.test.ts \
  src/modules/schema-generator/service.test.ts
```

预期：FAIL，新选项不存在。

- [ ] **步骤 4：更新 task-service**

`onPublished` 回调继续保留；server 注入的回调负责：

1. regenerate schema
2. build llms.txt
3. publisher.publish

task-service 只保证 publish 状态机不被外部失败破坏。

- [ ] **步骤 5：更新 auto-sections**

接口改为：

```typescript
buildSections(workspaceId: string, opts?: { publishedOnly?: boolean }): Promise<AutoSectionsResult>
```

ContentPage 查询在 `publishedOnly` 为 true 时增加 `status: 'PUBLISHED'`。

- [ ] **步骤 6：运行测试验证通过**

运行同步骤 3 命令。

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/modules/content-optimizer/task-service.ts src/modules/schema-generator/auto-sections.ts src/modules/schema-generator/service.ts src/modules/**/*.test.ts
git commit -m "feat(publisher): publish reviewed GEO artifacts"
```

---

## 任务 12：前端展示回测与发布结果

**文件：**
- 修改：`web/src/views/citation/EffectComparison.vue`
- 修改：`web/src/views/content/Tasks.vue`
- 修改：`web/src/views/Settings.vue`

- [ ] **步骤 1：更新 EffectComparison**

展示新字段：

- `brandMentionRate`
- `sourceCitationRate`
- `avgAnswerRank`
- `avgSourceRank`
- `avgSovScore`

保留旧字段 fallback。

- [ ] **步骤 2：更新 Tasks**

任务发布后展示 publication status 摘要：

- `SUCCEEDED`
- `FAILED`
- 错误信息入口

- [ ] **步骤 3：更新 Settings**

新增 publication target 基础配置表单：

- target type
- webhook URL
- file export base path
- git patch target paths

- [ ] **步骤 4：运行前端类型检查**

运行：`pnpm --filter geo-web build`

预期：构建通过，无 Vue/TS 类型错误。

- [ ] **步骤 5：Commit**

```bash
git add web/src/views/citation/EffectComparison.vue web/src/views/content/Tasks.vue web/src/views/Settings.vue
git commit -m "feat(web): show GEO source citation metrics and publication status"
```

---

## 任务 13：全量验证与文档更新

**文件：**
- 修改：`docs/架构与业务逻辑.md`
- 修改：`docs/GEO设计.md`

- [ ] **步骤 1：更新架构文档**

补充：

- citation vs mention 的区别
- source citation rate
- publisher 闭环
- evidence-aware rewrite

- [ ] **步骤 2：运行全量测试**

运行：`pnpm test`

预期：全部测试 PASS。

- [ ] **步骤 3：运行构建**

运行：`pnpm build`

预期：TypeScript 构建 PASS。

- [ ] **步骤 4：检查 git 状态**

运行：`git status --short`

预期：只包含本阶段预期修改。

- [ ] **步骤 5：Commit**

```bash
git add docs/架构与业务逻辑.md docs/GEO设计.md
git commit -m "docs: describe hardened GEO measurement and publication loop"
```

---

## 自检清单

- 规格需求“真实 citation/grounding”由任务 2、3、4、5 覆盖。
- 规格需求“query cluster/page mapping”由任务 6 覆盖。
- 规格需求“回测指标”由任务 7 和任务 12 覆盖。
- 规格需求“发布适配器和记录”由任务 8、9、11、12 覆盖。
- 规格需求“事实证据和改写策略”由任务 10 覆盖。
- 规格需求“Schema / llms.txt 发布增强”由任务 11 覆盖。
- 迁移兼容由任务 1、2、5、6、7 覆盖。

---

## 执行建议

推荐按三个 PR 拆分：

1. **Measurement PR**：任务 1-7，解决真实 citation 和回测指标。
2. **Publication PR**：任务 8-9、11-12，解决发布闭环。
3. **Trust PR**：任务 10、13，解决事实证据和文档收口。

每个 PR 都可以独立运行单元测试；Measurement PR 合并后即可开始采集更可信的 baseline。
