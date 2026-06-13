# Schema Generator + Knowledge Graph 阶段 3 设计

> **上游规格：** `docs/superpowers/specs/2026-06-13-geo-system-design.md` 第九章"阶段 3"
> **前置条件：** 阶段 1（基础设施 + Citation Monitor）和阶段 2（Content Optimizer）已完成并合并到 main，91 个测试全部通过

---

## 一、设计决策摘要

| 决策项 | 选定方案 | 理由 |
|--------|---------|------|
| 实体抽取架构 | 共享 `core/extract/` + Schema/KG 双适配器 | 单次 LLM 调用同时服务两边，单一事实来源 |
| KG 数据来源 | 手动 CRUD（直接入库）+ 自动抽取（走审核） | 灵活兼顾两类场景，符合"AI 生成 100% 审核"原则 |
| KG 审核流 | 复用 `OptimizationTask`（type=UPDATE_KG） | 不引入并行状态机，复用阶段 2 基础设施 |
| 触发入口 | 多入口：手动 API + `taskService.publish` 回调 | 兼顾主动触发和闭环联动 |
| Schema.org 覆盖 | 静态白名单 6 种 + 内置必填字段表 | 可验证、可测试，避免 LLM 自由发挥 |
| llms.txt 数据源 | 手动传 sections + `autoBuildSections` 辅助 | 调用方可控 + 系统可辅助 |
| 任务联动方式 | `taskService` 增加 `onPublished` 回调钩子 | 最小侵入，不重构阶段 2 代码 |
| RDF Turtle 导出 | 手写 RDF 字符串拼接，避免重型依赖 | 阶段 3 只需基础 Turtle，无需 SPARQL 等能力 |
| 关系自动推断（RelationBuilder） | 推迟到后续 | 阶段 3 仅做手动 relation，relation 自动推断留待后续 |

---

## 二、模块架构

### 2.1 整体依赖关系

```
┌─────────────────────────────────────────────────────────────────┐
│ core/extract/               共享实体抽取层                         │
│ ├─ entity-extractor.ts      LLM 抽 RawEntity + Relation          │
│ ├─ types.ts                 RawEntity / ExtractionResult 类型     │
│ └─ adapters/                                                 │
│    ├─ schema-adapter.ts     RawEntity → SchemaEntity（白名单）   │
│    └─ kg-adapter.ts         RawEntity → KgEntityDraft            │
├─────────────────────────────────────────────────────────────────┤
│ modules/schema-generator/                                       │
│ ├─ schema-registry.ts       6 种类型 + 必填字段表                 │
│ ├─ jsonld-builder.ts        组装 JSON-LD                         │
│ ├─ llms-txt-builder.ts      组装 llms.txt markdown               │
│ ├─ validator.ts             schema.org 校验                      │
│ ├─ auto-sections.ts         autoBuildSections 辅助               │
│ ├─ service.ts               编排 + SchemaRecord CRUD             │
│ └─ router.ts                tRPC 路由                            │
├─────────────────────────────────────────────────────────────────┤
│ modules/knowledge-graph/                                        │
│ ├─ repository.ts            KgEntity/KgRelation CRUD              │
│ ├─ extractor.ts             = core.extractor + kg-adapter       │
│ ├─ exporter.ts              JSON-LD / RDF Turtle 导出            │
│ ├─ service.ts               编排                                 │
│ └─ router.ts                tRPC 路由                            │
├─────────────────────────────────────────────────────────────────┤
│ modules/content-optimizer/task-service.ts                        │
│ └─ 增加 onPublished 回调钩子（最小侵入）                        │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流

#### 2.2.1 Schema 手动生成

```
SDK / tRPC: geo.schema.generate.jsonLd({ pageUrl, schemaType, fields })
  ↓
schemaRouter.generate.jsonLd
  ↓
schemaService.generateJsonLd(input)
  ├─ JsonLdBuilder.build({ type, fields })   ← 纯函数
  ├─ SchemaValidator.validate(jsonld)        ← 校验失败抛 InvalidSchemaError
  ├─ SchemaRecord.create({ version: 1, ... })
  └─ return { jsonld, schemaRecordId }
```

#### 2.2.2 Schema 自动重新生成（task 发布触发）

```
taskService.publish(taskId)
  ├─ status: REVIEWED → PUBLISHED
  └─ onPublished(task) 回调
       ↓ (server.ts 装配)
       schemaService.regenerateForPage(task.pageId)
       ├─ 读取 ContentPage
       ├─ EntityExtractor.llmExtract(content)
       ├─ SchemaAdapter.adapt(rawEntities)
       ├─ JsonLdBuilder.build(per type)
       ├─ SchemaValidator.validate
       ├─ SchemaRecord.create({ version: prev+1 })
       └─ return new SchemaRecord
```

#### 2.2.3 KG 自动抽取（走审核）

```
SDK / tRPC: geo.kg.extractFromPage({ pageId })
  ↓
kgRouter.extractFromPage
  ↓
kgService.extractFromPage(input)
  ├─ 读取 ContentPage
  ├─ EntityExtractor.llmExtract(content) → ExtractionResult
  ├─ KgAdapter.adapt(rawEntities) → KgEntityDraft[]
  ├─ OptimizationTask.create({
  │     type: UPDATE_KG,
  │     status: PENDING,
  │     result: { proposals: [...], relations: [...] }
  │  })
  └─ return task

reviewApprove(taskId)
  ↓
taskService.review(id, approved=true)
  └─ onPublished(task) 回调
       ↓
       kgService.persistProposals(task.workspaceId, task.result.proposals)
       ├─ 逐个 proposals：
       │   ├─ KgRepository.findByName(workspaceId, name) 查重
       │   ├─ 不存在 → KgRepository.addEntity(...)
       │   └─ 存在 → 跳过（保留人工录入的优先）
       └─ 持久化 relations（两端实体都已存在才创建）
```

#### 2.2.4 KG 手动 CRUD

```
geo.kg.addEntity({ name, type, properties })
  ↓
kgRepository.addEntity(input)
  ├─ 已存在（按 workspaceId+name 唯一）→ 抛 DuplicateEntityError
  └─ 不存在 → 直接插入 KgEntity

geo.kg.addRelation({ from, to, type, properties? })
  ↓
kgRepository.addRelation(input)
  ├─ 校验两端实体存在
  └─ 插入 KgRelation（允许同 from+to 多条不同 type）
```

#### 2.2.5 llms.txt 生成

```
geo.schema.generate.llmsTxt({ sections, brandName, tagline, updateFrequency? })
  ↓
schemaRouter.generate.llmsTxt
  ↓
schemaService.generateLlmsTxt(input)
  ├─ LlmsTxtBuilder.build(input)   ← 纯函数
  ├─ SchemaRecord.create({ schemaType: 'LlmsTxt', llmsTxtSection: 'all', content: { markdown } })
  └─ return { markdown, schemaRecordId }

辅助：
geo.schema.autoSections({ workspaceId })
  ↓
schemaService.autoBuildSections(workspaceId)
  ├─ KG 实体（type=SoftwareApplication）→ 核心产品 section
  ├─ ContentPage（pageType in [blog, docs]）→ 权威资源 section
  ├─ ContentPage.optimizedContent 解析出 FaqPair[] → 常见问答 section
  ├─ Workspace 默认值 → 更新频率 section
  └─ return { sections: [...] }  ← 由调用方人工审核后再调 generate.llmsTxt
```

---

## 三、核心数据结构

### 3.1 共享层（core/extract）

```typescript
/** LLM 抽取的原始实体 */
export interface RawEntity {
  name: string                                    // 实体名
  rawType: string                                 // LLM 自由文本类型，如 "AI 设计工具"
  properties: Record<string, unknown>             // LLM 抽取的属性
  sourceSpan?: { start: number; end: number }     // 在原文中的位置（可选）
}

/** LLM 抽取的关系 */
export interface RawRelation {
  fromName: string
  toName: string
  relationType: string                            // 如 "competitor"、"hasFeature"
  properties?: Record<string, unknown>
}

/** 单次抽取的完整结果 */
export interface ExtractionResult {
  entities: RawEntity[]
  relations: RawRelation[]
  extractionNotes?: string                        // LLM 备注，调试用
}

/** 类型适配器接口 */
export interface TypeAdapter<TOut> {
  adapt(raw: RawEntity[]): TOut[]
}
```

### 3.2 Schema Generator 类型

```typescript
/** 适配器输出的 schema.org 实体（已映射到白名单类型） */
export interface SchemaEntity {
  type: SupportedSchemaType                       // 已规范化的类型
  fields: Record<string, unknown>                 // 已规范化的字段
}

/** 白名单类型（与 SchemaRegistry 保持同步） */
export type SupportedSchemaType =
  | 'SoftwareApplication'
  | 'Organization'
  | 'Product'
  | 'FAQPage'
  | 'Article'
  | 'BreadcrumbList'

/** Schema 类型定义 */
export interface SchemaTypeDefinition {
  type: SupportedSchemaType
  requiredFields: string[]
  optionalFields: string[]
  nestedTypes?: Record<string, SupportedSchemaType>
}

/** Validator 错误 */
export interface ValidationError {
  path: string                                    // e.g. "@type" 或 "applicationCategory"
  message: string
  code: 'MISSING_REQUIRED' | 'INVALID_TYPE' | 'INVALID_CONTEXT'
}

/** Validator 结果 */
export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

/** JSON-LD 文档 */
export interface JsonLdDocument {
  '@context': 'https://schema.org'
  '@type': SupportedSchemaType
  [key: string]: unknown
}

/** llms.txt section 输入 */
export interface LlmsTxtSection {
  title: string                                   // "核心产品"
  items: Array<{
    label: string                                 // "[功能 1]"
    url: string
    description: string                           // 一句话定义
  }>
}

/** llms.txt 完整输入 */
export interface LlmsTxtInput {
  brandName: string
  tagline: string
  sections: LlmsTxtSection[]
  updateFrequency?: {
    docs?: string                                 // "每周"
    blog?: string                                 // "每周 2 篇"
  }
}

/** autoBuildSections 输出 */
export interface AutoSectionsResult {
  sections: LlmsTxtSection[]
  warnings: string[]                              // 数据缺失提示
}
```

### 3.3 Knowledge Graph 类型

```typescript
/** KG 待入库实体（来自适配器或手动输入） */
export interface KgEntityDraft {
  name: string
  type: string                                    // KG 类型，比 schema.org 更灵活
  properties: Record<string, unknown>
  sourceUrl?: string
}

/** KG 待入库关系 */
export interface KgRelationDraft {
  fromName: string
  toName: string
  relationType: string
  properties?: Record<string, unknown>
}

/** KG 提案（持久化 OptimizationTask.result 用） */
export interface KgProposalSet {
  entities: KgEntityDraft[]
  relations: KgRelationDraft[]
  sourcePageUrl: string                           // 来源页面 URL（追踪用）
  extractedAt: string                             // ISO 8601
}

/** 导出格式 */
export type ExportFormat = 'jsonld' | 'turtle'

/** 导出选项 */
export interface ExportInput {
  workspaceId: string
  format: ExportFormat
  entityIds?: string[]                            // 不传则导出整个 workspace
}
```

---

## 四、数据库变更

### 4.1 新增模型

在 `prisma/schema.prisma` 中按 spec 3.2 节新增三个模型，并在 Workspace 增加关联。

```prisma
// ============ 模块 3：Schema 生成 ============

model SchemaRecord {
  id              String   @id @default(cuid())
  workspaceId     String
  workspace       Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  pageUrl         String                            // 对应页面 URL（llms.txt 用 '/'）
  schemaType      String                            // SoftwareApplication / FAQPage / 'LlmsTxt'
  content         Json                              // JSON-LD 内容或 llms.txt markdown 元数据
  llmsTxtSection  String?                           // 仅 llms.txt 时记录 'all' 或具体 section 名
  version         Int       @default(1)
  createdAt       DateTime  @default(now())

  @@index([workspaceId, pageUrl])
  @@index([workspaceId, schemaType])
}

// ============ 模块 4：知识图谱 ============

model KgEntity {
  id          String   @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  name        String
  type        String
  properties  Json      @default("{}")
  sourceUrl   String?
  createdAt   DateTime  @default(now())

  relationsFrom KgRelation[] @relation("RelationFrom")
  relationsTo   KgRelation[] @relation("RelationTo")

  @@unique([workspaceId, name])
  @@index([workspaceId, type])
}

model KgRelation {
  id           String   @id @default(cuid())
  fromEntityId String
  fromEntity   KgEntity  @relation("RelationFrom", fields: [fromEntityId], references: [id], onDelete: Cascade)
  toEntityId   String
  toEntity     KgEntity  @relation("RelationTo", fields: [toEntityId], references: [id], onDelete: Cascade)
  relationType String
  properties   Json      @default("{}")

  @@index([fromEntityId])
  @@index([toEntityId])
}
```

### 4.2 Workspace 模型更新

在现有 `Workspace` 模型中新增：

```prisma
  schemas           SchemaRecord[]
  entities          KgEntity[]
```

### 4.3 OptimizationTask 模型扩展

在现有 `OptimizationTask` 模型中新增可选字段（不破坏阶段 2 已合并代码）：

```prisma
  extractionProposals Json?   // KG 待持久化数据，type=UPDATE_KG 时使用
```

> **设计要点：** 不创建独立的 `KgDraft` 模型，复用 `OptimizationTask.result` + 新增 `extractionProposals` 字段。审核流走同一状态机（PENDING → REVIEWED → PUBLISHED → 触发持久化）。

### 4.4 设计要点

- `SchemaRecord.content` 字段统一存储两种内容：
  - JSON-LD：直接存 JSON 对象（schema.org 类型 + 字段）
  - llms.txt：存 `{ markdown: string }`（外层包一层方便区分）
- `SchemaRecord.version` 每次写入递增（regenerate 时 `prev.version + 1`）
- `KgEntity` 按 `(workspaceId, name)` 唯一约束，重复插入抛错
- `KgRelation` 不强制唯一约束（同一对实体可有多种关系）
- `extractionProposals` 字段为 JSON 可空，向后兼容阶段 2 任务

---

## 五、组件接口设计

### 5.1 共享层（core/extract/）

#### 5.1.1 EntityExtractor

```typescript
// src/core/extract/entity-extractor.ts

export interface EntityExtractorService {
  extract(content: string): Promise<ExtractionResult>
}

export function createEntityExtractor(llm: LlmProvider): EntityExtractorService
```

**实现要点：**
- `temperature: 0`：结构化任务，确定性优先
- Prompt 要求返回 JSON：`{ entities: [...], relations: [...], extractionNotes: '...' }`
- JSON 解析兜底：返回 `{ entities: [], relations: [], extractionNotes: 'parse_failed' }`

#### 5.1.2 SchemaTypeAdapter

```typescript
// src/core/extract/adapters/schema-adapter.ts

export interface SchemaAdapterService {
  adapt(raw: RawEntity[]): SchemaEntity[]
}

export function createSchemaAdapter(registry: SchemaRegistryService): SchemaAdapterService
```

**适配逻辑：**
- 遍历 `raw`，根据 `raw.rawType` 做关键词匹配，映射到 6 种白名单类型之一
- 关键词表（硬编码）：
  - "app" / "software" / "工具" / "应用" → `SoftwareApplication`
  - "company" / "org" / "公司" / "组织" → `Organization`
  - "product" / "产品" → `Product`
  - "faq" / "问答" → `FAQPage`（必须提供 mainEntity）
  - "article" / "blog" / "post" / "文章" → `Article`
  - "breadcrumb" / "面包屑" → `BreadcrumbList`
- 匹配失败的实体 → 跳过（记 warning）
- 映射后保留 `properties` 中的字段，过滤掉非白名单字段（按 `SchemaTypeDefinition.optionalFields`）

#### 5.1.3 KgTypeAdapter

```typescript
// src/core/extract/adapters/kg-adapter.ts

export interface KgAdapterService {
  adapt(raw: RawEntity[]): KgEntityDraft[]
}

export function createKgAdapter(): KgAdapterService
```

**适配逻辑：**
- 全部 `RawEntity` 直接转换为 `KgEntityDraft`
- `rawType` 直接作为 KG type（KG 类型不受限）
- `properties` 全部保留（不过滤）

### 5.2 Schema Generator 模块

#### 5.2.1 SchemaRegistry

```typescript
// src/modules/schema-generator/schema-registry.ts

export interface SchemaRegistryService {
  get(type: string): SchemaTypeDefinition | null
  isSupported(type: string): boolean
  list(): SupportedSchemaType[]
}

const SCHEMA_TYPES: Record<SupportedSchemaType, SchemaTypeDefinition> = {
  SoftwareApplication: {
    type: 'SoftwareApplication',
    requiredFields: ['name', 'applicationCategory'],
    optionalFields: ['description', 'url', 'offers', 'aggregateRating', 'operatingSystem'],
  },
  Organization: {
    type: 'Organization',
    requiredFields: ['name', 'url'],
    optionalFields: ['logo', 'description', 'sameAs'],
  },
  Product: {
    type: 'Product',
    requiredFields: ['name'],
    optionalFields: ['description', 'brand', 'offers', 'image'],
  },
  FAQPage: {
    type: 'FAQPage',
    requiredFields: ['mainEntity'],
    optionalFields: [],
  },
  Article: {
    type: 'Article',
    requiredFields: ['headline', 'author'],
    optionalFields: ['datePublished', 'image', 'articleBody'],
  },
  BreadcrumbList: {
    type: 'BreadcrumbList',
    requiredFields: ['itemListElement'],
    optionalFields: [],
  },
}
```

#### 5.2.2 JsonLdBuilder

```typescript
// src/modules/schema-generator/jsonld-builder.ts

export interface JsonLdBuilderService {
  build(input: { type: SupportedSchemaType; fields: Record<string, unknown> }): JsonLdDocument
}

export function createJsonLdBuilder(): JsonLdBuilderService
```

**实现要点：**
- 纯函数，无副作用
- 自动注入 `@context: 'https://schema.org'`
- 按 `registry.get(type)` 过滤字段：
  - 必填字段缺失 → 抛 `MissingRequiredFieldError`
  - 不在白名单的字段 → 丢弃（记 warning，不抛错）

#### 5.2.3 LlmsTxtBuilder

```typescript
// src/modules/schema-generator/llms-txt-builder.ts

export interface LlmsTxtBuilderService {
  build(input: LlmsTxtInput): string                              // 返回 markdown
  parseMarkdown(md: string): LlmsTxtInput | null                  // 解析已有 llms.txt（用于回读）
}

export function createLlmsTxtBuilder(): LlmsTxtBuilderService
```

**Markdown 输出格式：**

```markdown
# {brandName}
> {tagline}

## {section1.title}
- [{item.label}]({item.url}): {item.description}
- [{item2.label}]({item2.url}): {item2.description}

## {section2.title}
- ...

## 更新频率
- 文档：{docs}
- 博客：{blog}
```

**`parseMarkdown` 实现要点：**
- 正则切分 `^## ` 分隔 section
- 提取 `# ` 后品牌名、`> ` 后 tagline
- 提取每个 `- [{label}]({url}): {desc}` 格式行
- 解析失败返回 `null`（不抛错）

#### 5.2.4 SchemaValidator

```typescript
// src/modules/schema-generator/validator.ts

export interface SchemaValidatorService {
  validate(doc: unknown): ValidationResult
}

export function createSchemaValidator(registry: SchemaRegistryService): SchemaValidatorService
```

**校验规则：**
1. `doc` 必须是对象
2. `doc['@context']` 必须是 `'https://schema.org'`，否则 `INVALID_CONTEXT`
3. `doc['@type']` 必须在白名单，否则 `INVALID_TYPE`
4. 必填字段必须存在且非空，否则 `MISSING_REQUIRED`
5. 返回 `{ valid, errors }`，valid = errors.length === 0

#### 5.2.5 AutoSections

```typescript
// src/modules/schema-generator/auto-sections.ts

export interface AutoSectionsService {
  buildSections(workspaceId: string): Promise<AutoSectionsResult>
}

export function createAutoSections(deps: {
  prisma: PrismaClient
}): AutoSectionsService
```

**数据源映射：**
- 核心产品 section：`KgEntity` 中 `type === 'SoftwareApplication' | 'Product'` 的实体
- 权威资源 section：`ContentPage` 中 `pageType in ['blog', 'docs', 'whitepaper']` 的页面
- 常见问答 section：从 `ContentPage.optimizedContent` 解析 `FaqPair[]`，聚合去重
- 更新频率 section：从 `Workspace` 默认值（先用 `"每周"`，后续可配置）

#### 5.2.6 SchemaService

```typescript
// src/modules/schema-generator/service.ts

export interface SchemaService {
  // 手动生成
  generateJsonLd(input: {
    workspaceId: string
    pageUrl: string
    schemaType: SupportedSchemaType
    fields: Record<string, unknown>
  }): Promise<{ jsonld: JsonLdDocument; record: SchemaRecord }>

  generateLlmsTxt(input: {
    workspaceId: string
    pageUrl?: string                             // 默认 '/llms.txt'
    brandName: string
    tagline: string
    sections: LlmsTxtSection[]
    updateFrequency?: { docs?: string; blog?: string }
  }): Promise<{ markdown: string; record: SchemaRecord }>

  // 自动重新生成
  regenerateForPage(pageId: string): Promise<SchemaRecord[]>

  // 查询
  list(input: { workspaceId: string; pageUrl?: string; schemaType?: string }): Promise<SchemaRecord[]>
  getById(id: string): Promise<SchemaRecord | null>

  // 辅助
  buildAutoSections(workspaceId: string): Promise<AutoSectionsResult>
}

export function createSchemaService(deps: {
  prisma: PrismaClient
  extractor: EntityExtractorService
  schemaAdapter: SchemaAdapterService
  jsonLdBuilder: JsonLdBuilderService
  llmsTxtBuilder: LlmsTxtBuilderService
  validator: SchemaValidatorService
  autoSections: AutoSectionsService
  schemaRegistry: SchemaRegistryService
}): SchemaService
```

**`regenerateForPage` 实现：**
1. 读 `ContentPage` 取 `currentContent`
2. `extractor.extract(content)` → `ExtractionResult`
3. `schemaAdapter.adapt(entities)` → `SchemaEntity[]`
4. 对每个 `SchemaEntity`：
   - `jsonLdBuilder.build({ type, fields })`
   - `validator.validate(doc)` → 失败跳过该实体并记 warning
5. 查询该 `pageUrl` 已有 `SchemaRecord` 的最大 `version`
6. 批量插入新 `SchemaRecord`（version = max+1）
7. 返回新 records

### 5.3 Knowledge Graph 模块

#### 5.3.1 KgRepository

```typescript
// src/modules/knowledge-graph/repository.ts

export interface KgRepositoryService {
  // Entity CRUD
  findEntityByName(workspaceId: string, name: string): Promise<KgEntity | null>
  findEntityById(id: string): Promise<KgEntity | null>
  findEntities(workspaceId: string, opts?: { type?: string }): Promise<KgEntity[]>
  addEntity(input: {
    workspaceId: string
    name: string
    type: string
    properties: Record<string, unknown>
    sourceUrl?: string
  }): Promise<KgEntity>
  removeEntity(id: string): Promise<void>                        // 级联删除 relations

  // Relation CRUD
  findRelations(opts: { fromId?: string; toId?: string }): Promise<KgRelation[]>
  addRelation(input: {
    fromName: string
    toName: string
    relationType: string
    properties?: Record<string, unknown>
  }): Promise<KgRelation>
}

export function createKgRepository(prisma: PrismaClient): KgRepositoryService
```

**实现要点：**
- `addEntity` 用 `@@unique([workspaceId, name])` 保证唯一性，重复抛 `DuplicateEntityError`
- `addRelation` 先校验两端实体存在（按 `workspaceId + name` 查找），不存在抛 `EntityNotFoundError`
- `removeEntity` 利用 Prisma 级联删除（`onDelete: Cascade` 已配）

#### 5.3.2 KgExtractor

```typescript
// src/modules/knowledge-graph/extractor.ts

export interface KgExtractorService {
  extractFromPage(pageId: string): Promise<{
    proposals: KgProposalSet
    task: OptimizationTask
  }>
}

export function createKgExtractor(deps: {
  prisma: PrismaClient
  extractor: EntityExtractorService
  kgAdapter: KgAdapterService
}): KgExtractorService
```

**实现要点：**
- 读 `ContentPage` 取 `currentContent` 和 `url`
- `extractor.extract(content)` → `ExtractionResult`
- `kgAdapter.adapt(entities)` → `KgEntityDraft[]`
- 构造 `KgProposalSet = { entities, relations, sourcePageUrl, extractedAt }`
- 创建 `OptimizationTask`：
  - `type: UPDATE_KG`
  - `status: PENDING`
  - `result: { proposals, sourcePageUrl }`
  - `extractionProposals: proposals`（冗余存一份便于查询）

#### 5.3.3 GraphExporter

```typescript
// src/modules/knowledge-graph/exporter.ts

export interface GraphExporterService {
  export(input: ExportInput): Promise<string>
}

export function createGraphExporter(prisma: PrismaClient): GraphExporterService
```

**JSON-LD 输出结构：**

```json
{
  "@context": {
    "@vocab": "https://schema.org/",
    "kg": "https://your-domain.com/kg/"
  },
  "@graph": [
    {
      "@id": "kg:zoomer-ai",
      "@type": "SoftwareApplication",
      "name": "zoomer AI",
      "description": "...",
      "competitor": { "@id": "kg:notion" }
    }
  ]
}
```

**Turtle 输出结构：**

```turtle
@prefix kg: <https://your-domain.com/kg/> .
@prefix schema: <https://schema.org/> .

kg:zoomer-ai a schema:SoftwareApplication ;
    schema:name "zoomer AI" ;
    schema:description "..." ;
    kg:competitor kg:notion .
```

**实现要点：**
- JSON-LD：直接组装对象
- Turtle：手写字符串拼接（实体：`kg:{slug} a schema:{Type} .`，属性：缩进 + `schema:{prop} "value" .`）
- 无重型依赖

#### 5.3.4 KgService

```typescript
// src/modules/knowledge-graph/service.ts

export interface KgService {
  // 手动 CRUD（直接入库）
  addEntity(input: AddEntityInput): Promise<KgEntity>
  addRelation(input: AddRelationInput): Promise<KgRelation>
  removeEntity(id: string): Promise<void>

  // 自动抽取（走审核）
  extractFromPage(pageId: string): Promise<OptimizationTask>

  // 持久化提案（taskService onPublished 回调调用）
  persistProposals(workspaceId: string, proposals: KgProposalSet): Promise<{
    entitiesCreated: number
    entitiesSkipped: number
    relationsCreated: number
    relationsSkipped: number
  }>

  // 查询
  listEntities(workspaceId: string, opts?: { type?: string }): Promise<KgEntity[]>
  listRelations(opts: { fromId?: string; toId?: string }): Promise<KgRelation[]>
  getEntity(id: string): Promise<KgEntity | null>

  // 导出
  exportGraph(input: ExportInput): Promise<string>
}

export function createKgService(deps: {
  prisma: PrismaClient
  repository: KgRepositoryService
  extractor: KgExtractorService
  exporter: GraphExporterService
}): KgService
```

**`persistProposals` 实现：**
1. 遍历 `proposals.entities`：
   - `findEntityByName` 查重
   - 已存在 → `entitiesSkipped++`
   - 不存在 → `addEntity({ sourceUrl: proposals.sourcePageUrl, ... })`，`entitiesCreated++`
2. 遍历 `proposals.relations`：
   - 两端实体都存在 → `addRelation`，`relationsCreated++`
   - 任何一端缺失 → `relationsSkipped++`
3. 返回计数

### 5.4 任务联动钩子

#### 5.4.1 TaskService 扩展

```typescript
// src/modules/content-optimizer/task-service.ts（修改）

export interface TaskServiceDeps {
  prisma: PrismaClient
  onPublished?: (task: OptimizationTask) => Promise<void>     // 新增可选字段
}

export function createTaskService(deps: TaskServiceDeps): TaskService
```

**`publish` 方法改动（最小侵入）：**

```typescript
async publish(id: string): Promise<OptimizationTask> {
  const task = await this.prisma.optimizationTask.update({
    where: { id },
    data: { status: 'PUBLISHED' },
  })

  if (this.deps.onPublished) {
    await this.deps.onPublished(task)
  }

  return task
}
```

#### 5.4.2 server.ts 装配

```typescript
// src/server.ts

const taskService = createTaskService({
  prisma,
  onPublished: async (task) => {
    // 1. 触发 Schema 重新生成（仅内容类任务）
    if (task.pageId && (task.type === 'REWRITE_CONTENT' || task.type === 'OPTIMIZE_FOR_QUERY')) {
      await schemaService.regenerateForPage(task.pageId)
    }

    // 2. 持久化 KG 提案（仅 UPDATE_KG 任务）
    if (task.extractionProposals) {
      const proposals = task.extractionProposals as KgProposalSet
      await kgService.persistProposals(task.workspaceId, proposals)
    }
  },
})
```

---

## 六、tRPC 路由设计

### 6.1 schemaRouter

```typescript
// src/modules/schema-generator/router.ts

export const schemaRouter = router({
  // 生成
  generate: router({
    jsonLd: protectedProcedure
      .input(z.object({
        pageUrl: z.string(),
        schemaType: z.enum([
          'SoftwareApplication',
          'Organization',
          'Product',
          'FAQPage',
          'Article',
          'BreadcrumbList',
        ]),
        fields: z.record(z.unknown()),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.schema.generateJsonLd({
          workspaceId: ctx.workspaceId,
          ...input,
        })
      }),

    llmsTxt: protectedProcedure
      .input(z.object({
        pageUrl: z.string().optional(),                          // 默认 '/llms.txt'
        brandName: z.string(),
        tagline: z.string(),
        sections: z.array(z.object({
          title: z.string(),
          items: z.array(z.object({
            label: z.string(),
            url: z.string(),
            description: z.string(),
          })),
        })),
        updateFrequency: z.object({
          docs: z.string().optional(),
          blog: z.string().optional(),
        }).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.schema.generateLlmsTxt({
          workspaceId: ctx.workspaceId,
          ...input,
        })
      }),
  }),

  // 自动 sections 辅助
  autoSections: protectedProcedure
    .input(z.object({}))
    .query(async ({ ctx }) => {
      return ctx.services.schema.buildAutoSections(ctx.workspaceId)
    }),

  // 查询
  list: protectedProcedure
    .input(z.object({
      pageUrl: z.string().optional(),
      schemaType: z.string().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.schema.list({
        workspaceId: ctx.workspaceId,
        pageUrl: input?.pageUrl,
        schemaType: input?.schemaType,
      })
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.services.schema.getById(input.id)
    }),

  // 内部触发（被回调使用，protectedProcedure 已隔离 workspace）
  regenerateForPage: protectedProcedure
    .input(z.object({ pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.schema.regenerateForPage(input.pageId)
    }),
})
```

### 6.2 kgRouter

```typescript
// src/modules/knowledge-graph/router.ts

export const kgRouter = router({
  // 手动 CRUD
  addEntity: protectedProcedure
    .input(z.object({
      name: z.string(),
      type: z.string(),
      properties: z.record(z.unknown()).default({}),
      sourceUrl: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.addEntity({
        workspaceId: ctx.workspaceId,
        ...input,
      })
    }),

  addRelation: protectedProcedure
    .input(z.object({
      fromName: z.string(),
      toName: z.string(),
      relationType: z.string(),
      properties: z.record(z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.addRelation(input)
    }),

  removeEntity: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.removeEntity(input.id)
    }),

  // 查询
  listEntities: protectedProcedure
    .input(z.object({ type: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.listEntities(ctx.workspaceId, { type: input?.type })
    }),

  listRelations: protectedProcedure
    .input(z.object({
      fromId: z.string().optional(),
      toId: z.string().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.listRelations({
        fromId: input?.fromId,
        toId: input?.toId,
      })
    }),

  getEntity: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.getEntity(input.id)
    }),

  // 自动抽取
  extractFromPage: protectedProcedure
    .input(z.object({ pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.extractFromPage(input.pageId)
    }),

  // 导出
  export: protectedProcedure
    .input(z.object({
      format: z.enum(['jsonld', 'turtle']),
      entityIds: z.array(z.string()).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.exportGraph({
        workspaceId: ctx.workspaceId,
        format: input.format,
        entityIds: input.entityIds,
      })
    }),
})
```

### 6.3 总路由更新

```typescript
// src/router.ts
export const appRouter = router({
  workspace: workspaceRouter,
  citation: citationRouter,
  content: contentRouter,
  tasks: taskRouter,
  schema: schemaRouter,        // 新增
  kg: kgRouter,                // 新增
})
```

### 6.4 server.ts 组装

在 `main()` 中按依赖顺序组装：

```typescript
// 1. 共享层
const entityExtractor = createEntityExtractor(getLlmProvider())
const schemaRegistry = createSchemaRegistry()
const schemaAdapter = createSchemaAdapter(schemaRegistry)
const kgAdapter = createKgAdapter()

// 2. Schema Generator
const jsonLdBuilder = createJsonLdBuilder()
const llmsTxtBuilder = createLlmsTxtBuilder()
const validator = createSchemaValidator(schemaRegistry)
const autoSections = createAutoSections({ prisma })
const schemaService = createSchemaService({
  prisma, extractor: entityExtractor, schemaAdapter,
  jsonLdBuilder, llmsTxtBuilder, validator, autoSections, schemaRegistry,
})

// 3. Knowledge Graph
const kgRepository = createKgRepository(prisma)
const kgExtractor = createKgExtractor({ prisma, extractor: entityExtractor, kgAdapter })
const kgExporter = createGraphExporter(prisma)
const kgService = createKgService({
  prisma, repository: kgRepository, extractor: kgExtractor, exporter: kgExporter,
})

// 4. TaskService 增加回调钩子（最小侵入）
const taskService = createTaskService({
  prisma,
  onPublished: async (task) => {
    if (task.pageId && (task.type === 'REWRITE_CONTENT' || task.type === 'OPTIMIZE_FOR_QUERY')) {
      await schemaService.regenerateForPage(task.pageId)
    }
    if (task.extractionProposals) {
      const proposals = task.extractionProposals as KgProposalSet
      await kgService.persistProposals(task.workspaceId, proposals)
    }
  },
})

// 5. 注入 services
const services = {
  prisma, monitor, queryLibrary,
  orchestrator, taskService, atomizer, faqGenerator,
  schema: schemaService,
  kg: kgService,
}
```

---

## 七、测试策略

### 7.1 测试分层

| 层级 | 测试对象 | Mock 策略 |
|------|---------|-----------|
| 纯逻辑 | SchemaRegistry / JsonLdBuilder / LlmsTxtBuilder / Validator | 无 |
| 适配器 | SchemaAdapter / KgAdapter | 无（输入 RawEntity → 输出） |
| LLM 组件 | EntityExtractor | mock `LlmProvider` |
| 数据层 | KgRepository | mock `PrismaClient` |
| 编排层 | SchemaService / KgService / KgExtractor / AutoSections | mock 子组件 + Prisma |
| 任务联动 | TaskService.publish 回调触发 | mock onPublished + Prisma |
| 路由层 | schemaRouter / kgRouter | mock services |

### 7.2 测试文件清单

| 文件 | 测试重点 |
|------|---------|
| `core/extract/entity-extractor.test.ts` | LLM 正常 JSON 解析、非 JSON 兜底返回空结果 |
| `core/extract/adapters/schema-adapter.test.ts` | 6 种关键词映射、白名单字段过滤、未匹配跳过 |
| `core/extract/adapters/kg-adapter.test.ts` | RawEntity 直接转换、properties 全部保留 |
| `schema-generator/schema-registry.test.ts` | get/isSupported/list、白名单完整性 |
| `schema-generator/jsonld-builder.test.ts` | @context 注入、必填字段缺失抛错、白名单外字段过滤 |
| `schema-generator/llms-txt-builder.test.ts` | markdown 输出格式、parseMarkdown 回读、空 section 处理 |
| `schema-generator/validator.test.ts` | 4 种校验规则（context/type/required/nested）、多重错误聚合 |
| `schema-generator/auto-sections.test.ts` | 4 个 section 数据源聚合、warnings 收集 |
| `schema-generator/service.test.ts` | generateJsonLd/LlmsTxt 完整流程、regenerateForPage 版本递增 |
| `schema-generator/router.test.ts` | 路由输入校验、workspace 隔离 |
| `knowledge-graph/repository.test.ts` | CRUD、DuplicateEntityError、EntityNotFoundError、级联删除 |
| `knowledge-graph/extractor.test.ts` | 抽取 + 适配 + 创建 PENDING 任务 |
| `knowledge-graph/exporter.test.ts` | JSON-LD @graph 结构、Turtle 前缀 + 缩进格式 |
| `knowledge-graph/service.test.ts` | persistProposals 去重逻辑、exportGraph 格式分发 |
| `knowledge-graph/router.test.ts` | CRUD 路由、extract/export 路由、workspace 隔离 |
| `content-optimizer/task-service.test.ts` | publish 触发 onPublished 回调、回调失败不影响状态更新 |

### 7.3 关键测试用例

**SchemaValidator：**
- 合法 JSON-LD → `{ valid: true, errors: [] }`
- `@context` 错误 → `INVALID_CONTEXT`
- `@type` 不在白名单 → `INVALID_TYPE`
- 必填字段缺失（SoftwareApplication 缺 applicationCategory）→ `MISSING_REQUIRED`
- 多重错误同时报告（context 错 + type 错 + 缺字段）

**SchemaTypeAdapter：**
- rawType = "AI 设计工具"（中文含"工具"）→ `SoftwareApplication`
- rawType = "SaaS company" → `Organization`
- rawType = "未知类型" → 跳过（不抛错）
- properties 中含非白名单字段 → 过滤掉

**KgService.persistProposals：**
- 全部新实体 → entitiesCreated=N
- 部分已存在（人工录入）→ entitiesSkipped=M
- 关系两端都已存在 → relationsCreated=K
- 关系任一端缺失 → relationsSkipped=L

**TaskService.publish：**
- onPublished 未提供 → 不调用，正常更新状态
- onPublished 提供且成功 → 状态更新 + 回调执行
- onPublished 抛出 → 状态已更新（先更新后回调），回调失败被捕获并打日志（不抛给调用方）

**GraphExporter：**
- JSON-LD 格式输出 `@graph` 数组
- Turtle 格式输出 `@prefix` + 主语-谓语-宾语句子
- 空 workspace → 返回空 `@graph` / 仅 `@prefix`

---

## 八、文件结构

```
src/core/extract/
├── types.ts                                # RawEntity / ExtractionResult / TypeAdapter
├── entity-extractor.ts                     # LLM 抽取
├── entity-extractor.test.ts
└── adapters/
    ├── schema-adapter.ts                   # RawEntity → SchemaEntity
    ├── schema-adapter.test.ts
    ├── kg-adapter.ts                       # RawEntity → KgEntityDraft
    └── kg-adapter.test.ts

src/modules/schema-generator/
├── types.ts                                # SchemaEntity / JsonLdDocument / LlmsTxtInput 等
├── schema-registry.ts                      # 6 种类型 + 字段表
├── schema-registry.test.ts
├── jsonld-builder.ts                       # JSON-LD 组装
├── jsonld-builder.test.ts
├── llms-txt-builder.ts                     # llms.txt markdown 组装
├── llms-txt-builder.test.ts
├── validator.ts                            # schema.org 校验
├── validator.test.ts
├── auto-sections.ts                        # autoBuildSections 辅助
├── auto-sections.test.ts
├── service.ts                              # 编排 + SchemaRecord CRUD
├── service.test.ts
├── router.ts                               # schemaRouter
└── router.test.ts

src/modules/knowledge-graph/
├── types.ts                                # KgEntityDraft / KgProposalSet / ExportFormat
├── repository.ts                           # KgEntity / KgRelation CRUD
├── repository.test.ts
├── extractor.ts                            # = core.extractor + kg-adapter
├── extractor.test.ts
├── exporter.ts                             # JSON-LD / RDF Turtle 导出
├── exporter.test.ts
├── service.ts                              # 编排
├── service.test.ts
├── router.ts                               # kgRouter
└── router.test.ts

修改的现有文件：
- prisma/schema.prisma                     # 新增 SchemaRecord / KgEntity / KgRelation；扩展 OptimizationTask.extractionProposals
- src/modules/content-optimizer/task-service.ts  # 增加 onPublished 回调钩子
- src/server.ts                            # 组装新服务 + 配置回调
- src/router.ts                            # 注册 schemaRouter / kgRouter
```

---

## 九、范围边界

### 阶段 3 包含

- Schema 自动生成（JSON-LD，6 种白名单类型）
- llms.txt 自动生成
- schema.org 校验
- KG 实体 / 关系 CRUD（手动 + 自动抽取）
- JSON-LD / RDF Turtle 导出
- 自动触发：OptimizationTask 发布时回调
- 共享 `core/extract/` 实体抽取层

### 阶段 3 不包含

- Webhook 推送（`§6.4` SDK 接口） → 阶段 4
- Wikidata / 外部知识图谱对齐 → 后续
- 完整 schema.org JSON Schema 加载（仅维护内置白名单）
- KG 图查询语言（SPARQL）
- RelationBuilder（关系自动推断）→ 后续
- 跨 workspace 的实体合并 / 全局实体库
- SchemaRecord 编辑接口（仅 create + list + get，编辑靠 regenerateForPage）

---

## 十、依赖与第三方库

阶段 3 不引入新的第三方库：
- LLM 调用复用 `core/llm/LlmProvider`（阶段 1）
- Prisma 复用阶段 1 / 2 的 `PrismaClient`
- 校验、组装、解析全部手写（避免引入 ajv / n3.js 等重型库）

> 阶段 3 保持代码库零新增依赖。

---

## 自检

1. **占位符扫描：** 无 TODO / 待定 / 未完成章节。所有方法签名、字段、测试用例均已明确。

2. **内部一致性：**
   - 数据结构（第三章）与组件接口（第五章）完全对应
   - 数据库模型（第四章）与 tRPC 路由（第六章）字段一致
   - 测试用例（第七章 7.3）与组件接口签名（第五章）匹配
   - 任务联动钩子在 `TaskService.publish`（5.4.1）和 `server.ts`（6.4）定义一致
   - `OptimizationTask.extractionProposals` 字段在 Prisma（4.3）、KgExtractor（5.3.2）、server.ts（6.4）三处引用一致

3. **范围检查：** 聚焦阶段 3 的 4 个子任务（Schema 生成 / Schema 校验 / llms.txt 生成 / KG 实体关系 / KG 导出），不含 webhook（阶段 4）。可用一个实现计划覆盖。

4. **模糊性检查：**
   - 实体抽取共享：`core/extract/` + 双适配器，单次 LLM 调用同时服务两边
   - KG 自动抽取走审核：复用 `OptimizationTask.UPDATE_KG`，不引入并行状态机
   - Schema 自动触发：`onPublished` 回调钩子，触发条件明确（pageId 存在 + type ∈ 改写类）
   - 持久化提案去重：人工录入优先，自动抽取遇到重名跳过
   - RDF Turtle 导出：手写字符串拼接，明确输出格式
   - 0 新增第三方依赖：所有逻辑手写或复用既有组件