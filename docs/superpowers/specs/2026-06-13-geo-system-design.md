# GEO 系统设计（独立服务）

> **定位：** 本文档是一个**独立项目**的设计规格，不耦合到任何特定业务系统。未来作为独立 Git 仓库启动，各业务系统（如 zoomer-ai-base 等）通过 SDK 接入。
>
> **参考依据：** `docs/GEO设计.md`（GEO 开发指南）

---

## 一、项目概述

### 1.1 是什么

一套**可复用的 GEO（Generative Engine Optimization）系统**，以独立服务 + 轻量 SDK 的形态提供四大能力：

1. **AI 引用监测** — 跨多个 AI 平台追踪品牌"被引用"状态
2. **内容优化** — 把普通内容改写成 AI 友好形态
3. **Schema / llms.txt 生成** — 自动化生成结构化数据
4. **知识图谱构建** — 实体关系抽取与管理

### 1.2 核心价值

- **跨系统复用**：任意 Web 系统安装 SDK 即可接入，数据按 workspace 隔离
- **闭环驱动**：监测 → 发现问题 → 优化内容 → 验证效果，形成持续迭代闭环
- **独立部署**：与业务系统解耦，独立扩缩容，不影响主业务稳定性

### 1.3 设计原则

- **YAGNI**：不过度设计，从监测模块起步，按需扩展
- **人工审核必须**：AI 生成的内容 100% 需要人工审核，防止幻觉污染品牌
- **不做 LLM hack**：不搞 prompt injection、训练数据污染，合规优先
- **平台可插拔**：新增 AI 平台只需实现 adapter 接口

---

## 二、整体架构

### 2.1 架构选型：单体服务 + 插件化模块

```
┌─────────────────────────────────────────────────────────┐
│  geo-service (独立 Node 服务，Fastify + tRPC)            │
│                                                          │
│  modules/                                                │
│  ├── citation-monitor/   # 引用监测                      │
│  ├── content-optimizer/  # 内容优化                      │
│  ├── schema-generator/   # Schema / llms.txt 生成        │
│  └── knowledge-graph/    # 知识图谱                      │
│                                                          │
│  core/                   # 共享层                         │
│  ├── workspace/          # 多租户管理                     │
│  ├── llm/                # 统一 LLM 抽象（多 provider）   │
│  ├── db/                 # Prisma 客户端                  │
│  └── queue/              # pg-boss 任务队列              │
│                                                          │
│  sdk/                    # @scope/geo-sdk（同仓发包）     │
│  server.ts               # Fastify 启动入口              │
└─────────────────────────────────────────────────────────┘
         ↑ SDK / tRPC 调用
   ┌─────┴─────┬──────────┬──────────┐
   │           │          │          │
系统 A      系统 B      系统 C    更多系统
```

**选型理由：**
- 4 个模块共享 LLM 调用层、workspace 管理、任务队列，拆成微服务会产生大量重复
- 单体不影响跨系统复用——各系统通过 SDK 调用同一套 API
- 后续若某模块压力大（如 citation-monitor 需高频抓取），可单独剥离

### 2.2 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（Node.js） | 与接入系统技术栈统一，SDK 类型安全，LLM 生态丰富 |
| 服务框架 | Fastify + tRPC | 高性能，端到端类型安全，tRPC router 自动推导 SDK 类型 |
| 数据库 | PostgreSQL + pgvector | 原生向量检索支持（query 聚类、语义匹配） |
| 任务队列 | pg-boss | 基于 PostgreSQL，无需额外引入 Redis |
| LLM 调用 | 统一抽象层 | 支持 OpenAI / Anthropic / Google / DeepSeek 多 provider 切换 |
| SDK 发包 | TypeScript 包（同仓） | tRPC 推导类型，接入系统获得完整类型提示 |
| 部署 | 独立进程 / Docker | 与主业务解耦 |

### 2.3 项目目录结构

```
geo-service/
├── src/
│   ├── modules/
│   │   ├── citation-monitor/
│   │   │   ├── platform-adapters/     # 各 AI 平台适配器
│   │   │   │   ├── base.ts            # PlatformAdapter 接口
│   │   │   │   ├── openai.ts
│   │   │   │   ├── perplexity.ts
│   │   │   │   ├── anthropic.ts
│   │   │   │   ├── gemini.ts
│   │   │   │   └── deepseek.ts
│   │   │   ├── query-library.ts       # query 库管理
│   │   │   ├── analyzer.ts            # 引用分析（SOV、排名）
│   │   │   ├── monitor.ts             # 监测调度
│   │   │   └── router.ts              # tRPC 路由
│   │   ├── content-optimizer/
│   │   │   ├── atomizer.ts            # 内容原子化
│   │   │   ├── rewriter.ts            # LLM 改写
│   │   │   ├── faq-generator.ts       # FAQ 生成
│   │   │   ├── scoring.ts             # AI 友好度评分
│   │   │   └── router.ts
│   │   ├── schema-generator/
│   │   │   ├── extractor.ts           # 实体抽取
│   │   │   ├── jsonld-builder.ts      # JSON-LD 生成
│   │   │   ├── llms-txt-builder.ts    # llms.txt 生成
│   │   │   ├── validator.ts           # schema.org 校验
│   │   │   └── router.ts
│   │   └── knowledge-graph/
│   │       ├── entity-extractor.ts    # 实体抽取
│   │       ├── relation-builder.ts    # 关系构建
│   │       ├── graph-exporter.ts      # RDF / JSON-LD 导出
│   │       └── router.ts
│   ├── core/
│   │   ├── workspace/
│   │   │   ├── service.ts             # workspace CRUD
│   │   │   ├── auth.ts                # API Key 认证
│   │   │   └── router.ts
│   │   ├── llm/
│   │   │   ├── client.ts              # 统一 LLM 客户端
│   │   │   ├── providers/             # 各 provider 实现
│   │   │   └── prompt-templates/      # 共享 prompt 模板
│   │   ├── db/
│   │   │   └── client.ts              # Prisma 客户端
│   │   └── queue/
│   │       └── boss.ts                # pg-boss 实例
│   ├── workers/
│   │   ├── citation-scheduler.ts      # 定时监测任务
│   │   └── optimization-runner.ts     # 闭环优化任务
│   ├── server.ts                      # Fastify 启动
│   └── router.ts                      # tRPC 总路由
├── sdk/
│   ├── src/
│   │   ├── client.ts                  # createGeoClient()
│   │   ├── types.ts                   # 从服务端 tRPC 推导
│   │   └── index.ts
│   └── package.json                   # @scope/geo-sdk
├── prisma/
│   └── schema.prisma
├── package.json
├── tsconfig.json
├── docker-compose.yml                 # PostgreSQL + 服务
└── README.md
```

---

## 三、数据模型

### 3.1 设计原则

- **所有业务表以 `workspaceId` 做租户隔离**
- workspace = 一个接入系统（如 zoomer-ai-base 对应一个 workspace）
- 每个 workspace 有独立的 API Key、AI 平台凭证、query 库

### 3.2 Prisma Schema 核心模型

```prisma
// ============ 基础：多租户 ============

model Workspace {
  id                String   @id @default(cuid())
  name              String                          // 接入系统名称，如 "zoomer-ai-base"
  domain            String?                         // 系统域名，如 "zoomer.top"
  llmsTxtUrl        String?                         // llms.txt 部署地址
  defaultBrandName  String                          // 默认品牌名，如 "zoomer AI"
  apiKeyHash        String                          // API Key 哈希
  platformConfig    Json      @default("{}")        // 各 AI 平台 API key（加密）
  status            WorkspaceStatus @default(ACTIVE)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  queries           CitationQuery[]
  events            CitationEvent[]
  pages             ContentPage[]
  schemas           SchemaRecord[]
  entities          KgEntity[]
  tasks             OptimizationTask[]
}

enum WorkspaceStatus {
  ACTIVE
  SUSPENDED
}

// ============ 模块 1：引用监测 ============

model CitationQuery {
  id          String   @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  queryText   String                              // 用户会问的 query，如 "AI设计工具哪个好"
  intent      Json      @default("{}")            // { type, category, urgency }
  source      QuerySource                          // query 来源
  status      QueryStatus @default(ACTIVE)
  embedding   Unsupported("vector(1536)")?         // pgvector，query 聚类用
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  events      CitationEvent[]

  @@index([workspaceId, status])
}

enum QuerySource {
  GOOGLE_SUGGEST    // Google 搜索建议
  LLM_GENERATED     // LLM 生成
  PAA               // People Also Ask
  MANUAL            // 手动录入
  COMPETITOR        // 竞品反推
}

enum QueryStatus {
  ACTIVE
  PAUSED
}

model CitationEvent {
  id            String   @id @default(cuid())
  workspaceId   String
  workspace     Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  queryId       String
  query         CitationQuery @relation(fields: [queryId], references: [id], onDelete: Cascade)
  platform      String                            // openai / perplexity / anthropic / gemini / deepseek
  brandMentioned Boolean                           // 品牌是否在答案中出现
  rankInAnswer  Int?                               // 品牌在答案中的排名（vs 竞品）
  citedUrls     Json      @default("[]")           // [{ url, position, snippet }]
  competitors   Json      @default("[]")           // [{ brand, mentioned, rank }]
  rawAnswer     String   @db.Text                  // AI 原始回答
  sovScore      Float?                             // Share of Voice 分数
  embedding     Unsupported("vector(1536)")?        // pgvector，答案聚类用
  capturedAt    DateTime  @default(now())

  @@index([workspaceId, platform, capturedAt])
  @@index([queryId, capturedAt])
}

// ============ 模块 2：内容优化 ============

model ContentPage {
  id                String   @id @default(cuid())
  workspaceId       String
  workspace         Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  url               String                            // 受管理页面 URL
  pageType          String                            // landing / about / pricing / blog ...
  currentContent    String   @db.Text                 // 当前内容
  optimizedContent  String?  @db.Text                 // 优化后内容（待审核）
  optimizationScore Float?                            // AI 友好度评分（0-100）
  status            ContentStatus @default(DRAFT)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  tasks             OptimizationTask[]

  @@unique([workspaceId, url])
  @@index([workspaceId, status])
}

enum ContentStatus {
  DRAFT       // 草稿
  REVIEWED    // 已审核
  PUBLISHED   // 已发布
}

// ============ 模块 3：Schema 生成 ============

model SchemaRecord {
  id          String   @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  pageUrl     String                              // 对应页面
  schemaType  String                              // SoftwareApplication / FAQPage / Organization ...
  content     Json                                // JSON-LD 内容
  llmsTxtSection String?                          // 如果是 llms.txt 的某个段落
  version     Int       @default(1)               // 版本号，每次更新递增
  createdAt   DateTime  @default(now())

  @@index([workspaceId, pageUrl])
}

// ============ 模块 4：知识图谱 ============

model KgEntity {
  id          String   @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  name        String                              // 实体名，如 "zoomer AI"
  type        String                              // SoftwareApplication / Organization ...
  properties  Json      @default("{}")            // 实体属性
  sourceUrl   String?                             // 来源页面
  createdAt   DateTime  @default(now())

  relationsFrom KgRelation[] @relation("RelationFrom")
  relationsTo   KgRelation[] @relation("RelationTo")

  @@unique([workspaceId, name])
  @@index([workspaceId, type])
}

model KgRelation {
  id          String   @id @default(cuid())
  fromEntityId String
  fromEntity   KgEntity  @relation("RelationFrom", fields: [fromEntityId], references: [id], onDelete: Cascade)
  toEntityId   String
  toEntity     KgEntity  @relation("RelationTo", fields: [toEntityId], references: [id], onDelete: Cascade)
  relationType String                                // competitor / audience / feature ...
  properties   Json      @default("{}")

  @@index([fromEntityId])
  @@index([toEntityId])
}

// ============ 闭环：优化任务 ============

model OptimizationTask {
  id           String   @id @default(cuid())
  workspaceId  String
  workspace    Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  type         TaskType                              // optimize-for-query / rewrite-content ...
  queryId      String?                               // 触发 query（监测发现未被引用时）
  query        CitationQuery?  @relation(fields: [queryId], references: [id])
  pageId       String?                               // 待优化页面
  page        ContentPage?    @relation(fields: [pageId], references: [id])
  status       TaskStatus    @default(PENDING)
  beforeScore  Float?                                // 优化前评分
  afterScore   Float?                                // 优化后评分
  result       Json?                                 // 优化结果摘要
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@index([workspaceId, status])
}

enum TaskType {
  OPTIMIZE_FOR_QUERY    // 针对 query 优化内容
  REWRITE_CONTENT       // 重写内容
  GENERATE_SCHEMA       // 生成 Schema
  UPDATE_KG             // 更新知识图谱
}

enum TaskStatus {
  PENDING       // 待处理
  IN_PROGRESS   // 进行中
  REVIEWED      // 已人工审核
  PUBLISHED     // 已发布
  FAILED        // 失败
}
```

### 3.3 向量索引（pgvector）

```sql
-- citation_queries: 按 query 语义聚类
CREATE INDEX idx_citation_query_embedding
  ON "CitationQuery" USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- citation_events: 按答案语义聚类，发现相似问题
CREATE INDEX idx_citation_event_embedding
  ON "CitationEvent" USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

---

## 四、SDK 接口设计

### 4.1 包信息

- **包名**：`@scope/geo-sdk`（scope 按实际组织定）
- **同仓管理**：放在 `geo-service/sdk/` 目录，独立 `package.json`
- **类型来源**：从服务端 tRPC router 自动推导，接入系统获得端到端类型提示

### 4.2 初始化

```typescript
import { createGeoClient } from '@scope/geo-sdk'

const geo = createGeoClient({
  serviceUrl: 'https://geo.your-domain.com',
  apiKey: process.env.GEO_API_KEY!,  // workspace 级密钥
})
```

### 4.3 接口清单

```typescript
const geo = createGeoClient({ ... })

// ========== 1. 引用监测 ==========

// 手动触发单次监测
geo.citation.trackQuery.mutate({
  query: 'AI设计工具哪个好',
  brand: 'zoomer AI',
  platforms: ['openai', 'perplexity'],
})

// 批量监测
geo.citation.batchTrack.mutate({
  queries: ['AI设计工具', '白模生图工具', '...'],
  platforms: ['openai', 'perplexity', 'deepseek'],
})

// 查询报告
geo.citation.getReport.query({
  dateRange: { start: '2026-06-01', end: '2026-06-13' },
  platform: 'openai',
})

// Share of Voice
geo.citation.getSovScore.query({
  competitors: ['notion', 'figma'],
  dateRange: { start: '2026-06-01', end: '2026-06-13' },
})

// Query 库管理
geo.citation.queries.list.query({ status: 'active' })
geo.citation.queries.add.mutate({
  queryText: 'AI设计工具',
  source: 'manual',
  intent: { type: 'comparison', category: 'tool' },
})
geo.citation.queries.generate.mutate({
  topic: 'AI 设计工具',
  count: 50,
})  // LLM 批量生成 query

// ========== 2. 内容优化 ==========

// 优化单页内容
geo.content.optimize.mutate({
  pageUrl: 'https://example.com/landing',
  content: '原始内容...',
})

// 内容原子化（拆成可独立引用的单元）
geo.content.atomize.mutate({
  text: '原始长文本...',
})

// 生成 FAQ
geo.content.generateFaq.mutate({
  topic: 'AI设计工具',
  count: 5,
})

// 页面管理
geo.content.pages.list.query()
geo.content.pages.upsert.mutate({
  url: 'https://example.com/landing',
  pageType: 'landing',
  currentContent: '...',
})

// ========== 3. Schema / llms.txt 生成 ==========

// 生成 JSON-LD
geo.schema.generate.mutate({
  type: 'SoftwareApplication',
  url: 'https://example.com',
  fields: {
    name: '...',
    description: '...',
    applicationCategory: 'DesignApplication',
  },
})

// 生成 llms.txt
geo.schema.generateLlmsTxt.mutate({
  sections: [
    { title: '核心产品', items: [...] },
    { title: '权威资源', items: [...] },
    { title: '常见问答', items: [...] },
  ],
})

// 查询已生成的 schema
geo.schema.list.query({ pageUrl: 'https://example.com' })

// ========== 4. 知识图谱 ==========

geo.kg.addEntity.mutate({
  name: 'Example App',
  type: 'SoftwareApplication',
  properties: { description: '...' },
})

geo.kg.addRelation.mutate({
  from: 'Example App',
  to: 'Competitor X',
  type: 'competitor',
})

geo.kg.export.query({ format: 'jsonld' })  // jsonld / rdf

// ========== 5. 闭环任务 ==========

geo.tasks.create.mutate({
  type: 'optimize-for-query',
  queryId: '...',
  pageId: '...',
})

geo.tasks.list.query({ status: 'pending' })
geo.tasks.review.mutate({ id: '...', approved: true })
```

### 4.4 Webhook 回调

GEO 服务在关键事件发生时回调接入系统（需接入系统在 SDK 初始化时配置 webhook URL）：

```typescript
const geo = createGeoClient({
  serviceUrl: '...',
  apiKey: '...',
  webhookUrl: 'https://your-system.com/api/geo-webhook',  // 可选
})

// GEO 服务会 POST 以下事件：
// - optimization.completed  内容优化完成，待审核
// - schema.generated        Schema 生成完成
// - citation.alert          引用率异常下降告警
```

---

## 五、四大模块详细设计

### 5.1 模块 1：Citation Monitor（引用监测）

#### 职责

知道"用户在 AI 里问什么、谁被引用了、我排第几"。

#### 架构

```
┌──────────────────────────────────────────────────┐
│ Citation Monitor                                  │
│                                                   │
│  QueryLibrary            PlatformAdapters          │
│  ├─ Google Suggest       ├─ OpenAI (search preview)│
│  ├─ LLM 批量生成          ├─ Perplexity (sonar)     │
│  ├─ PAA 抓取             ├─ Claude (web search)    │
│  └─ 手动录入              ├─ Gemini (grounding)     │
│                          └─ DeepSeek               │
│                                                   │
│  CitationAnalyzer                                 │
│  ├─ 品牌提及检测（文本匹配 + 语义匹配）             │
│  ├─ URL 引用提取                                   │
│  ├─ 排名计算（vs 竞品在答案中的位置）               │
│  └─ SOV（Share of Voice）计算                      │
└──────────────────────────────────────────────────┘
```

#### 平台适配器接口

```typescript
// src/modules/citation-monitor/platform-adapters/base.ts

interface PlatformAdapter {
  name: string
  query(text: string): Promise<PlatformResult>
}

interface PlatformResult {
  answer: string                    // AI 原始回答
  citations: CitationEntry[]        // 引用来源
  mentionedBrands: string[]         // 答案中提及的品牌
}

interface CitationEntry {
  url: string
  position: number                  // 在引用列表中的位置
  snippet?: string                  // 引用片段
}
```

新增平台只需实现此接口，注册到 adapter registry。

#### 监测流程

1. `pg-boss` 定时任务（默认每日一次，可配置）触发
2. 从 `CitationQuery` 取该 workspace 下所有 `ACTIVE` 状态的 query
3. 并发调用已配置的平台 adapter（并发数可配，避免触发 rate limit）
4. 每个 adapter 返回 `{ answer, citations, mentionedBrands }`
5. `CitationAnalyzer` 统一分析：
   - 品牌是否被提及（文本匹配 + embedding 语义匹配）
   - 品牌排第几（答案中出现的顺序 vs 竞品）
   - 引用了哪些 URL
   - 计算 SOV（品牌提及次数 / 所有竞品提及次数总和）
6. 写入 `CitationEvent`，计算 answer embedding 供后续聚类

#### query 库构建方式

| 来源 | 方式 |
|---|---|
| `GOOGLE_SUGGEST` | 抓取 Google Suggest、Related Searches、People Also Ask |
| `LLM_GENERATED` | 调 LLM 生成："为某产品生成 N 个用户会问的 AI 搜索 query" |
| `PAA` | AnswerThePublic、AlsoAsked 数据 |
| `MANUAL` | 人工录入核心 query |
| `COMPETITOR` | 监控竞品在 LLM 中被引用的"前序 query"，反推 |

---

### 5.2 模块 2：Content Optimizer（内容优化）

#### 职责

把普通内容改写成"AI 友好切片"，提升被 AI 引用的概率。

#### 架构

```
┌──────────────────────────────────────────────────┐
│ Content Optimizer                                 │
│                                                   │
│  ContentAtomizer         LlmRewriter               │
│  ├─ 语义切分（段落级）     ├─ 补充数字 / 时间锚点    │
│  ├─ 实体提取              ├─ 形容词 → 可验证事实     │
│  └─ 独立性检查             └─ 生成定义句             │
│                                                   │
│  FaqGenerator            ScoringEngine             │
│  ├─ 5W1H 问答生成        ├─ 原子化率（目标 > 80%）  │
│  └─ 高频 query 匹配       ├─ 切片独立性              │
│                          └─ FAQ 覆盖度              │
└──────────────────────────────────────────────────┘
```

#### 内容原子化标准

每个原子单元必须包含：
- **实体**（subject）：这段在说谁
- **事实**（predicate + object）：说了什么
- **数据锚点**：具体数字、时间、机构名（至少一个）
- **出处**：可验证的来源

#### 核心 Prompt 模板

```text
你是一个 GEO 优化专家。把以下内容改写为"AI 答案友好"形态：
1. 每段必须含具体数字、时间或机构名
2. 把形容词替换为可验证的事实
3. 补充 3-5 个用户可能问的具体问题及答案
4. 在开头给出 1 句"定义句"（subject + is + value）
5. 输出 JSON: { atoms: [...], faq: [...], schema: {...} }
```

#### 评估指标

| 指标 | 定义 | 目标 |
|---|---|---|
| 原子化率 | 段落含数字 / 实体 / 出处的比例 | > 80% |
| 切片独立性 | 任一段切出后仍能自解释 | 100% |
| FAQ 覆盖度 | 与高频 query 的 cosine 相似度 | 持续提升 |

#### 流程

1. 接收原始内容（来自 `ContentPage` 或 SDK 直接传入）
2. `ContentAtomizer` 用 LLM 做语义切分，每段提取 subject / predicate / object / anchors
3. `ScoringEngine` 对每段评分，不达标的交给 `LlmRewriter` 重写
4. `FaqGenerator` 基于高频 query 库生成问答对
5. 输出优化后的内容 + 评分报告
6. **人工审核后才标记为 `PUBLISHED`**（AI 生成内容 100% 需人工审核）

---

### 5.3 模块 3：Schema & llms.txt Generator

#### 职责

自动生成结构化数据，让 AI 爬虫和 RAG 系统更容易理解和引用站点内容。

#### 架构

```
┌──────────────────────────────────────────────────┐
│ Schema Generator                                  │
│                                                   │
│  SchemaExtractor         LlmsTxtBuilder             │
│  ├─ 从内容抽取实体        ├─ 按 llms.txt 规范组装    │
│  ├─ 映射 Schema.org 类型  ├─ 核心产品段              │
│  └─ 生成 JSON-LD         ├─ 权威资源段              │
│                          ├─ FAQ 段                  │
│  SchemaValidator         └─ 更新频率段              │
│  ├─ schema.org 校验                               │
│  └─ 结构完整性                                    │
└──────────────────────────────────────────────────┘
```

#### llms.txt 规范

llms.txt 是 Answer.AI 提出的 AI 爬虫协议，类似 robots.txt 但专门给 LLM 用：

```markdown
# {品牌名}
> {一句话定义}

## 核心产品
- [功能 1](url): 一句话定义
- [功能 2](url): 一句话定义

## 权威资源
- [白皮书](url): 描述
- [技术博客](url): 描述

## 常见问答
- Q: ... A: ...
- Q: ... A: ...

## 更新频率
- 文档：每周
- 博客：每周 2 篇
```

#### JSON-LD 生成

支持类型：`SoftwareApplication`、`Organization`、`Product`、`FAQPage`、`Article`、`BreadcrumbList` 等。

```typescript
// 输出示例
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "...",
  "description": "...",
  "url": "...",
  "applicationCategory": "...",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "ratingCount": "126" }
}
```

#### 部署机制

- 每次内容更新触发重新生成
- 写入 `SchemaRecord` 表，版本号递增
- 通过 SDK webhook 通知接入系统部署到 `/llms.txt` 和页面 `<script type="application/ld+json">`

---

### 5.4 模块 4：Knowledge Graph Builder（知识图谱）

#### 职责

让品牌的"实体"在 Schema.org / 知识图谱体系中可被识别。

#### 架构

```
┌──────────────────────────────────────────────────┐
│ Knowledge Graph Builder                           │
│                                                   │
│  EntityExtractor         RelationBuilder            │
│  ├─ 从内容抽取实体        ├─ 实体间关系推断          │
│  ├─ 类型分类              ├─ 竞品 / 上下游映射       │
│  └─ 存入 KgEntity         └─ 存入 KgRelation        │
│                                                   │
│  GraphExporter                                    │
│  ├─ 导出 JSON-LD                                  │
│  ├─ 导出 RDF / Turtle                             │
│  └─ 外部知识图谱对齐建议（如 Wikidata）             │
└──────────────────────────────────────────────────┘
```

#### 收益定位

- 对**通用知识**类的 AI 答案（医疗、法律、科学）有强作用
- 对**商业 SaaS** 的引用率影响相对有限
- 但 Schema.org 标记对**站内页面被 RAG 检索的概率**有显著正向作用

---

## 六、数据反馈闭环

这是整个 GEO 系统的核心价值——把监测和优化串成持续迭代闭环。

### 闭环流程

```
┌─────────────────────────────────────────────────────────┐
│                                                          │
│  1. 每日定时监测                                          │
│     pg-boss 触发 → 遍历 active queries → 调用平台 adapter │
│                                                          │
│  2. 发现问题                                              │
│     某 query 品牌未被引用 / 排名下降                       │
│       ↓                                                  │
│     自动创建 OptimizationTask                             │
│     （关联 query + 推荐优化哪篇内容）                      │
│                                                          │
│  3. 内容优化                                              │
│     Content Optimizer 生成改写方案                        │
│       ↓                                                  │
│     人工审核 → 标记 REVIEWED                              │
│                                                          │
│  4. 部署                                                  │
│     SDK webhook 通知接入系统发布                          │
│       ↓                                                  │
│     Schema Generator 更新 JSON-LD / llms.txt             │
│       ↓                                                  │
│     Knowledge Graph 更新实体                             │
│                                                          │
│  5. 验证                                                  │
│     下一轮监测验证该 query 的引用率变化                    │
│       ↓                                                  │
│     before_score vs after_score → 效果度量               │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 任务状态机

```
PENDING → IN_PROGRESS → REVIEWED → PUBLISHED
                ↓
              FAILED
```

- `PENDING`：系统自动创建或手动创建
- `IN_PROGRESS`：Content Optimizer 正在处理
- `REVIEWED`：人工审核通过，等待发布
- `PUBLISHED`：已通过 SDK 部署到接入系统
- `FAILED`：优化失败（LLM 错误、评分过低等）

---

## 七、接入方式

### 7.1 通用接入流程（适用于任何系统）

1. **创建 workspace**：在 GEO 服务后台注册，获取 `workspace_id` 和 `API Key`
2. **配置平台凭证**：填入各 AI 平台的 API key（OpenAI / Perplexity / 等）
3. **安装 SDK**：`pnpm add @scope/geo-sdk`
4. **初始化客户端**：传入 `serviceUrl` 和 `apiKey`
5. **导入内容**：通过 SDK 把需要 GEO 优化的页面录入 `ContentPage`
6. **建 query 库**：手动录入或 LLM 生成核心 query
7. **启动监测**：配置定时任务，开始跑 baseline
8. **查看报告**：通过 SDK API 或 GEO 服务 dashboard 查看引用情况

### 7.2 接入示例（Node/TypeScript 系统）

```typescript
import { createGeoClient } from '@scope/geo-sdk'

const geo = createGeoClient({
  serviceUrl: process.env.GEO_SERVICE_URL!,
  apiKey: process.env.GEO_API_KEY!,
})

// 1. 导入页面
await geo.content.pages.upsert.mutate({
  url: 'https://your-site.com/landing',
  pageType: 'landing',
  currentContent: '...',
})

// 2. 生成 query 库
await geo.citation.queries.generate.mutate({
  topic: '你的产品领域',
  count: 50,
})

// 3. 跑一次 baseline
const report = await geo.citation.getReport.query({
  dateRange: { start: '2026-06-01', end: '2026-06-13' },
})
console.log('当前 SOV:', report.sovScore)
```

---

## 八、安全与合规

### 8.1 红线（不做的事）

- **不买"现成 GEO 源码"**：那种代码是前端壳子，核心 AI 集成都是空的
- **不做"全自动发布"**：AI 改写的内容 100% 需人工审核，防止幻觉反向污染品牌
- **不 hack LLM**：prompt injection、训练数据污染、伪装权威信源——一旦被抓到品牌会被永久降权
- **不"一次投入长期收益"**：AI 模型版本每月在变，内容工程必须能持续迭代

### 8.2 数据安全

- 各 workspace 的 AI 平台 API key 加密存储
- API Key 认证：每个 workspace 一个 key，哈希存储
- `raw_answer` 字段可能含敏感信息，按 workspace 隔离，不跨租户泄露

---

## 九、落地路线

### 阶段 1：基础设施 + Citation Monitor（MVP 起点）

**目标：** 跑通监测闭环，产出第一份 baseline 数据。

- 搭建 geo-service 骨架（Fastify + tRPC + Prisma + pg-boss）
- workspace 管理 + API Key 认证
- 5 个平台 adapter（OpenAI、Perplexity、Claude、Gemini、DeepSeek）
- query 库管理（手动录入 + LLM 生成）
- pg-boss 定时监测任务
- CitationAnalyzer（品牌提及、排名、SOV）
- 基础报告 API
- SDK 基础封装

### 阶段 2：Content Optimizer

**目标：** 能基于监测结果自动产出内容优化方案。

- ContentAtomizer（语义切分 + 实体提取）
- ScoringEngine（AI 友好度评分）
- LlmRewriter（不达标段落重写）
- FaqGenerator（问答对生成）
- OptimizationTask 管理
- 人工审核流程

### 阶段 3：Schema Generator + Knowledge Graph

**目标：** 补齐结构化数据输出能力。

- Schema 自动生成（JSON-LD）
- llms.txt 自动生成
- schema.org 校验
- 知识图谱实体 / 关系管理
- RDF / JSON-LD 导出

### 阶段 4：闭环 + SDK 打磨

**目标：** 完整闭环，多系统接入验证。

- OptimizationTask 完整闭环（监测 → 优化 → 部署 → 验证）
- SDK 完善类型 + 文档
- webhook 双向通知
- Dashboard（可选，或纯 API 供接入系统自建）
- 多系统接入验证

---

## 十、验收标准

### 整体验收

- [ ] 独立部署，不依赖任何特定业务系统
- [ ] 任意系统通过 SDK 接入，数据按 workspace 隔离
- [ ] 四大模块功能完整可用
- [ ] 闭环流程跑通：监测 → 优化 → 部署 → 验证

### 模块验收

**Citation Monitor：**
- [ ] 支持 5 个 AI 平台并发监测
- [ ] 准确检测品牌提及和引用 URL
- [ ] 计算 SOV 和排名
- [ ] 定时任务稳定运行

**Content Optimizer：**
- [ ] 内容原子化率 > 80%
- [ ] 生成 FAQ 覆盖高频 query
- [ ] 人工审核流程完整

**Schema Generator：**
- [ ] 支持至少 5 种 Schema.org 类型
- [ ] 生成合规的 llms.txt
- [ ] webhook 通知接入系统部署

**Knowledge Graph：**
- [ ] 实体 / 关系 CRUD 完整
- [ ] 支持 JSON-LD 和 RDF 导出

---

## 自检

1. **占位符扫描：** 无 TODO / 待定 / 未完成章节。
2. **内部一致性：** 架构、数据模型、SDK 接口、模块设计之间无矛盾。Prisma 模型字段与 SDK 接口对应。
3. **范围检查：** 本规格聚焦 GEO 独立服务的设计，不包含具体代码实现。实现计划由后续 writing-plans 产出。
4. **模糊性检查：** 各模块职责边界清晰，平台适配器接口明确，闭环流程状态机确定。
5. **独立性：** 本设计不耦合到 zoomer-ai-base 或任何特定业务系统，各系统以 workspace 身份平等接入。
