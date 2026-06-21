# GEO 优化增强设计

> **上游背景：** 基于当前 `docs/架构与业务逻辑.md`、阶段 1/2/3 设计与代码实现评估。
> **定位：** 本规格用于把现有 GEO Console 从 MVP 骨架升级为可验证、可发布、可回测的生产闭环。

---

## 一、问题陈述

当前系统已经覆盖 Citation Monitor、Content Optimizer、Schema / llms.txt 和 Knowledge Graph 四条主线，但主要能力仍停留在 Console 内部闭环：

1. **引用监测不够真实**：多数平台适配器通过普通 chat API 获取回答，再用 URL 正则抽取链接；只有 Perplexity 读取了平台返回的 citations 字段。系统无法稳定区分“答案文本提到品牌”“显式来源引用了品牌页面”“模型联网 grounding 使用了品牌页面”。
2. **发布未落到公网**：`publish` 只更新数据库状态并触发内部 Schema 记录生成，没有写回目标站点、CMS、Git 仓库、静态文件或 webhook。
3. **效果对比指标偏粗**：现有 SOV 主要是品牌提及率或文本出现次数，没有区分 source citation rate、citation rank、query cluster、平台差异和优化前后时间窗。
4. **内容评分和改写缺少事实约束**：评分规则适合任务排序，但不能证明引用率提升；改写 prompt 要求补数字/机构名，但没有强制来源、置信度或“不能凭空新增事实”的机制。
5. **query 库和页面映射不足**：query 可以手动或 LLM 生成，但缺少稳定的 intent/cluster/page mapping，使监测结果难以自动反哺具体页面。

本规格不推翻现有架构，而是在现有模块上补齐生产级 GEO 所需的可观测性、发布、回测和可信度边界。

---

## 二、目标与非目标

### 2.1 目标

- 让 Citation Monitor 记录平台返回的结构化 citation / grounding source，而不是只依赖答案文本和 URL 正则。
- 引入统一的 GEO 结果指标：品牌提及、来源引用、来源排名、答案排名、SOV、query cluster 维度的优化前后 delta。
- 新增 Publisher 抽象，把审核通过的优化结果发布到可配置目标，并保留发布记录。
- 增强 Content Optimizer 的事实治理：新增事实来源、置信度、事实新增策略，避免 LLM 幻觉污染品牌内容。
- 增强 Query Library：支持 intent、cluster、mappedPageUrl、priority，使监测结果能映射到内容优化任务。
- 保持现有 Fastify + tRPC + Prisma + Vitest 技术栈，不引入新的数据库或队列系统。

### 2.2 非目标

- 不做 prompt injection、训练数据污染、隐藏文本、诱导爬虫等黑帽 GEO。
- 不在本阶段接入真实 Google Search Console、Bing Webmaster 或第三方 SEO 数据源；只预留接口和发布事件。
- 不实现完整 CMS 插件生态；本阶段只提供 webhook、file export 和 git patch 三种发布适配器骨架。
- 不承诺任何平台的引用率必然提升；本系统只提供可验证的监测、发布和回测能力。

---

## 三、设计决策摘要

| 决策项 | 选定方案 | 理由 |
|--------|----------|------|
| citation 数据模型 | 扩展 `CitationEvent` JSON 字段保存 raw citation/grounding source | 避免频繁迁移大量平台差异字段，同时保留可查询核心指标 |
| 平台结果接口 | `PlatformResult` 增加 `answerMentions`、`sourceCitations`、`groundingSources`、`raw` | 统一适配器输出，兼容无 citation 平台 |
| 指标计算 | 新增 `metrics.ts`，从 event 聚合生成 `GeoMetricsSnapshot` | 避免 router 内散落统计逻辑 |
| 发布链路 | 新增 `publisher` 模块，`taskService.publish` 通过回调触发 | 延续阶段 3 的 `onPublished` 钩子，低侵入 |
| 内容事实约束 | Atom/Faq 增加 `evidence`，改写策略支持 `allowNewFacts` | 人工审核前让新增事实可见、可追踪 |
| query 组织 | CitationQuery 增加 cluster/page/priority 字段 | 支持按页面和意图回测，而非只按 query 列表跑 |

---

## 四、模块设计

### 4.1 Citation Monitor 增强

#### 4.1.1 新的 PlatformResult

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
```

适配器必须优先使用平台结构化 citation / grounding 字段；只有平台不提供结构化来源时，才将答案中的 URL 正则匹配标记为 `sourceType: 'answer_url'`。

#### 4.1.2 CitationAnalysis

```typescript
export interface CitationAnalysis {
  brandMentioned: boolean
  brandSourceCited: boolean
  rankInAnswer: number | null
  sourceRank: number | null
  sovScore: number
  sourceCitationRate: number
  competitors: CompetitorMention[]
}
```

核心判断规则：

- `brandMentioned`：答案正文出现品牌别名。
- `brandSourceCited`：`sourceCitations` 或 `groundingSources` 中存在 workspace domain、品牌 URL 或配置的 canonical host。
- `rankInAnswer`：主品牌在答案中相对竞品首次出现位置。
- `sourceRank`：品牌来源在 source list 中的位置。
- `sovScore`：答案提及权重和来源引用权重组合，默认 `0.4 * answerShare + 0.6 * sourceShare`。

### 4.2 Query Library 增强

`CitationQuery` 增加以下业务字段：

```prisma
intentType     String?
cluster        String?
mappedPageUrl  String?
priority       Int      @default(3)
lastRunAt      DateTime?
```

`generateQueries` 输出不再只是字符串数组，而是结构化 query：

```typescript
interface GeneratedQueryDraft {
  queryText: string
  intentType: 'comparison' | 'alternative' | 'how_to' | 'definition' | 'pricing' | 'integration' | 'other'
  cluster: string
  mappedPageUrl?: string
  priority: 1 | 2 | 3 | 4 | 5
}
```

当 LLM 返回旧格式字符串数组时，服务继续兼容并用默认字段补齐。

### 4.3 效果回测与指标

新增 `src/modules/citation-monitor/metrics.ts`，负责按时间窗、平台、cluster、page 聚合事件。

```typescript
interface GeoMetricsSnapshot {
  totalEvents: number
  brandMentionRate: number
  sourceCitationRate: number
  avgAnswerRank: number | null
  avgSourceRank: number | null
  avgSovScore: number
}

interface GeoEffectComparison {
  before: GeoMetricsSnapshot
  after: GeoMetricsSnapshot
  delta: {
    brandMentionRate: number
    sourceCitationRate: number
    avgAnswerRank: number | null
    avgSourceRank: number | null
    avgSovScore: number
  }
}
```

router 的 `getEffectComparison` 改为调用 metrics service，避免重复统计逻辑。

### 4.4 Publisher 模块

新增 `src/modules/publisher/`：

```
src/modules/publisher/
├── types.ts
├── registry.ts
├── service.ts
├── adapters/
│   ├── webhook.ts
│   ├── file-export.ts
│   └── git-patch.ts
└── *.test.ts
```

#### 发布目标

1. `webhook`：向客户系统发送优化结果、JSON-LD 和 llms.txt。
2. `file_export`：在本服务生成可下载文件记录，便于手动部署。
3. `git_patch`：生成 patch 内容和目标路径，不直接执行 git push。

#### 发布记录

新增 `PublicationRecord`：

```prisma
model PublicationRecord {
  id          String   @id @default(cuid())
  workspaceId String
  taskId      String?
  pageUrl     String
  targetType  String
  status      PublicationStatus @default(PENDING)
  payload     Json
  response    Json?
  error       String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

enum PublicationStatus {
  PENDING
  SUCCEEDED
  FAILED
}
```

发布失败不回滚审核状态，但必须记录 `FAILED` 和错误信息，并在 Dashboard 可见。

### 4.5 内容可信度增强

内容类型增加证据字段：

```typescript
interface Evidence {
  sourceUrl?: string
  sourceTitle?: string
  sourceType: 'user_input' | 'existing_page' | 'citation_source' | 'manual' | 'unknown'
  confidence: number
}

interface Atom {
  text: string
  subject: string
  predicate: string
  object: string
  anchors: string[]
  definition?: string
  evidence?: Evidence[]
}
```

改写服务增加选项：

```typescript
interface RewriteOptions {
  allowNewFacts: boolean
  requiredEvidenceForNewFacts: boolean
}
```

默认策略：

- `allowNewFacts: false`
- `requiredEvidenceForNewFacts: true`

当需要新增数字、时间、统计或第三方机构信息时，LLM 必须输出 evidence；没有 evidence 的新增事实标记为低置信度，并进入人工审核重点。

### 4.6 Schema / llms.txt 部署增强

`generateLlmsTxt` 继续生成 Markdown，但 Publisher 负责把 Markdown 变成可部署 payload：

- `/llms.txt`
- 页面 JSON-LD script
- FAQPage JSON-LD
- 可选 `sitemap-hints.json`

`auto-sections` 需要优先使用已发布页面和带 source citation 的 URL，避免把未审核内容推入 llms.txt。

---

## 五、数据模型变更

### 5.1 CitationEvent 扩展

```prisma
model CitationEvent {
  ...
  brandSourceCited Boolean @default(false)
  sourceRank       Int?
  sourceCitations  Json    @default("[]")
  groundingSources Json    @default("[]")
  analysis         Json    @default("{}")
}
```

保留现有 `citedUrls`，迁移期将它作为 `sourceCitations` 的兼容来源。

### 5.2 CitationQuery 扩展

```prisma
model CitationQuery {
  ...
  intentType    String?
  cluster       String?
  mappedPageUrl String?
  priority      Int      @default(3)
  lastRunAt     DateTime?
}
```

### 5.3 ContentPage 扩展

```prisma
model ContentPage {
  ...
  publishedContent String?
  lastPublishedAt  DateTime?
}
```

### 5.4 Workspace 扩展

```prisma
model Workspace {
  ...
  publicationConfig Json @default("{}")
  publicationRecords PublicationRecord[]
}
```

---

## 六、API 变更

### 6.1 citation router

- `getReport` 支持 `cluster`、`mappedPageUrl`、`brandSourceCited` 过滤。
- `getSovScore` 返回 mention 和 source citation 两套指标。
- `getEffectComparison` 返回 `GeoEffectComparison`。
- `queries.add` 支持 `intentType`、`cluster`、`mappedPageUrl`、`priority`。
- `queries.generate` 返回结构化 query draft，并落库。

### 6.2 content router

- `optimize` 支持 `rewriteOptions`。
- `tasks.publish` 触发 Publisher，并返回 publication result 摘要。

### 6.3 schema router

- `generate.llmsTxt` 可选择 `publishedOnly`。
- `autoSections` 返回 warnings 时必须保留到响应，供前端展示。

### 6.4 publisher router

新增：

- `publisher.records.list`
- `publisher.records.get`
- `publisher.retry`

---

## 七、测试策略

### 7.1 单元测试

- 平台适配器：mock fetch，覆盖结构化 citations、grounding metadata、纯文本 URL fallback。
- analyzer：覆盖品牌别名、domain 匹配、source rank、竞品提及、SOV 权重。
- metrics：覆盖 before/after、空样本、rank 越小越好、cluster/page 过滤。
- publisher：覆盖 webhook 成功/失败、file export payload、git patch payload。
- content optimizer：覆盖 `allowNewFacts=false` 时 prompt 不允许新增事实；缺 evidence 时低置信度标记。

### 7.2 集成测试

- 从 query 监测到 CitationEvent 落库，验证 source citation 字段。
- 从内容优化审核发布到 PublicationRecord，验证失败不会吞掉错误。
- 从发布后回测，到 `getEffectComparison` 输出 source citation delta。

### 7.3 验证命令

```bash
pnpm test
pnpm build
```

如果本地没有依赖，先运行：

```bash
pnpm install
```

---

## 八、验收标准

1. 至少 OpenAI、Gemini、Anthropic、Perplexity 四个适配器输出统一 `PlatformResult`，其中 Perplexity 使用 API citations，Gemini/Anthropic/OpenAI 支持结构化 citation/grounding 字段或明确 fallback。
2. `CitationEvent` 中能区分 `brandMentioned` 和 `brandSourceCited`，并记录 `sourceRank`。
3. `getEffectComparison` 返回 source citation rate delta，而不是只返回提及率。
4. 审核发布后会创建 `PublicationRecord`，成功/失败均可追踪。
5. 内容改写默认不新增无来源事实；新增事实必须暴露 evidence 和 confidence。
6. Query 可以按 cluster 和 mappedPageUrl 聚合，回测报告能定位到页面。
7. 全量单元测试和构建通过。

---

## 九、迁移与兼容

- 旧 `citedUrls` 保留，新增代码写入 `sourceCitations`，读取时兼容旧字段。
- 旧 `generateQueries` 文本数组输出继续可解析，缺失字段使用 `intentType='other'`、`priority=3`。
- 旧 `OptimizationResult` 中没有 evidence 时视为 `sourceType='existing_page'`、`confidence=0.6`。
- 发布功能默认关闭；workspace 未配置 `publicationConfig` 时，publish 只保持当前行为并记录 warning。

---

## 十、风险

- 平台 citation 字段和 web search API 会变化，适配器测试必须固定最小可依赖字段。
- 发布适配器涉及外部系统，必须默认失败可见、不可静默丢失。
- 过度追求数字锚点会诱导 LLM 编造事实，事实证据约束必须优先于评分提升。
- llms.txt 仍不是所有 AI 平台的强制标准，收益应通过回测衡量，而不是作为确定性承诺。
