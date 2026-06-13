# Schema Generator + Knowledge Graph 阶段 3 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 Schema Generator（JSON-LD + llms.txt + schema.org 校验）和 Knowledge Graph（实体/关系 CRUD + JSON-LD/RDF 导出）两个模块，闭环联动阶段 2 的 OptimizationTask 发布事件。

**架构：** 共享 `core/extract/` 实体抽取层（一次 LLM 调用同时产出 schema.org 适配器和 KG 适配器的输入）+ 双模块独立编排。Schema 6 种白名单类型（纯函数构建/校验）+ KG 手动 CRUD 直入库、自动抽取走 `OptimizationTask.UPDATE_KG` 审核。任务联动通过 `taskService.publish` 的 `onPublished` 回调钩子实现，最小侵入阶段 2 代码。

**技术栈：** TypeScript / Node.js、tRPC 10、Prisma 5、Vitest。复用阶段 1 的 `LlmProvider` 和 `PrismaClient`，零新增第三方依赖。

**规格依据：** `docs/superpowers/specs/2026-06-13-schema-kg-phase3-design.md`

**范围边界（本计划不包含）：** Webhook 推送（阶段 4）、Wikidata 对齐、SPARQL 图查询、RelationBuilder（关系自动推断）、跨 workspace 实体合并。

---

## 文件结构

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
- prisma/schema.prisma                                       # 新增 SchemaRecord / KgEntity / KgRelation；扩展 OptimizationTask.extractionProposals
- src/modules/content-optimizer/task-service.ts              # 增加 onPublished 回调钩子
- src/modules/content-optimizer/task-service.test.ts         # 增加回调触发测试
- src/server.ts                                              # 组装新服务 + 配置回调
- src/router.ts                                              # 注册 schemaRouter / kgRouter
```

---

## 任务 1：Prisma Schema 变更

**文件：**
- 修改：`prisma/schema.prisma`

- [ ] **步骤 1：在 Workspace 模型中增加 `schemas` 和 `entities` 关联**

在 `prisma/schema.prisma` 的 `Workspace` 模型中（`tasks OptimizationTask[]` 之后）追加：

```prisma
  schemas           SchemaRecord[]
  entities          KgEntity[]
```

- [ ] **步骤 2：在文件末尾追加 SchemaRecord 模型**

在 `prisma/schema.prisma` 的最后一个 enum `TaskStatus` 之后追加：

```prisma
// ============ 模块 3：Schema 生成 ============

model SchemaRecord {
  id              String   @id @default(cuid())
  workspaceId     String
  workspace       Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  pageUrl         String
  schemaType      String
  content         Json
  llmsTxtSection  String?
  version         Int       @default(1)
  createdAt       DateTime  @default(now())

  @@index([workspaceId, pageUrl])
  @@index([workspaceId, schemaType])
}
```

- [ ] **步骤 3：追加 KgEntity 和 KgRelation 模型**

紧接着追加：

```prisma
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

- [ ] **步骤 4：扩展 OptimizationTask 增加 `extractionProposals` 字段**

修改 `OptimizationTask` 模型，在 `reviewNote String? @db.Text` 之后增加一行：

```prisma
  extractionProposals Json?
```

完整模型片段（仅展示与原文不同的部分）：

```prisma
model OptimizationTask {
  id                  String      @id @default(cuid())
  workspaceId         String
  workspace           Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  type                TaskType
  queryId             String?
  query               CitationQuery? @relation(fields: [queryId], references: [id])
  pageId              String?
  page                ContentPage?   @relation(fields: [pageId], references: [id])
  status              TaskStatus  @default(PENDING)
  beforeScore         Float?
  afterScore          Float?
  result              Json?
  reviewNote          String?     @db.Text
  extractionProposals Json?        // 新增：KG 待持久化数据，type=UPDATE_KG 时使用
  createdAt           DateTime    @default(now())
  updatedAt           DateTime    @updatedAt

  @@index([workspaceId, status])
}
```

- [ ] **步骤 5：生成 Prisma Client 并验证**

运行：`npx prisma generate`
预期：输出 "Generated Prisma Client"，无错误。

- [ ] **步骤 6：Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): add SchemaRecord, KgEntity, KgRelation and extractionProposals for phase 3"
```

---

## 任务 2：核心共享层类型定义（core/extract）

**文件：**
- 创建：`src/core/extract/types.ts`

- [ ] **步骤 1：编写类型文件**

创建 `src/core/extract/types.ts`：

```typescript
/** LLM 抽取的原始实体 */
export interface RawEntity {
  name: string
  rawType: string
  properties: Record<string, unknown>
  sourceSpan?: { start: number; end: number }
}

/** LLM 抽取的关系 */
export interface RawRelation {
  fromName: string
  toName: string
  relationType: string
  properties?: Record<string, unknown>
}

/** 单次抽取的完整结果 */
export interface ExtractionResult {
  entities: RawEntity[]
  relations: RawRelation[]
  extractionNotes?: string
}

/** 类型适配器接口：把原始实体映射到目标领域类型 */
export interface TypeAdapter<TOut> {
  adapt(raw: RawEntity[]): TOut[]
}
```

- [ ] **步骤 2：验证编译**

运行：`npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add src/core/extract/types.ts
git commit -m "feat(extract): add core entity extraction type definitions"
```

---

## 任务 3：SchemaGenerator 与 KnowledgeGraph 模块类型定义

**文件：**
- 创建：`src/modules/schema-generator/types.ts`
- 创建：`src/modules/knowledge-graph/types.ts`

- [ ] **步骤 1：编写 schema-generator 类型文件**

创建 `src/modules/schema-generator/types.ts`：

```typescript
/** 白名单类型 */
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
}

/** 适配器输出的 schema.org 实体 */
export interface SchemaEntity {
  type: SupportedSchemaType
  fields: Record<string, unknown>
}

/** Validator 错误 */
export interface ValidationError {
  path: string
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
  title: string
  items: Array<{
    label: string
    url: string
    description: string
  }>
}

/** llms.txt 完整输入 */
export interface LlmsTxtInput {
  brandName: string
  tagline: string
  sections: LlmsTxtSection[]
  updateFrequency?: {
    docs?: string
    blog?: string
  }
}

/** autoBuildSections 输出 */
export interface AutoSectionsResult {
  sections: LlmsTxtSection[]
  warnings: string[]
}
```

- [ ] **步骤 2：编写 knowledge-graph 类型文件**

创建 `src/modules/knowledge-graph/types.ts`：

```typescript
/** KG 待入库实体 */
export interface KgEntityDraft {
  name: string
  type: string
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

/** KG 提案（持久化到 OptimizationTask.result 用） */
export interface KgProposalSet {
  entities: KgEntityDraft[]
  relations: KgRelationDraft[]
  sourcePageUrl: string
  extractedAt: string
}

/** 导出格式 */
export type ExportFormat = 'jsonld' | 'turtle'

/** 导出选项 */
export interface ExportInput {
  workspaceId: string
  format: ExportFormat
  entityIds?: string[]
}
```

- [ ] **步骤 3：验证编译**

运行：`npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 4：Commit**

```bash
git add src/modules/schema-generator/types.ts src/modules/knowledge-graph/types.ts
git commit -m "feat(phase3): add schema-generator and knowledge-graph type definitions"
```

---

## 任务 4：SchemaRegistry（静态白名单）

**文件：**
- 创建：`src/modules/schema-generator/schema-registry.ts`
- 测试：`src/modules/schema-generator/schema-registry.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/schema-generator/schema-registry.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { createSchemaRegistry, SUPPORTED_TYPES } from './schema-registry.js'

describe('SchemaRegistry', () => {
  const registry = createSchemaRegistry()

  it('list 返回全部 6 种支持的类型', () => {
    const types = registry.list()
    expect(types).toHaveLength(6)
    expect(types).toEqual(expect.arrayContaining(SUPPORTED_TYPES))
  })

  it('isSupported 对白名单类型返回 true', () => {
    expect(registry.isSupported('SoftwareApplication')).toBe(true)
    expect(registry.isSupported('Organization')).toBe(true)
    expect(registry.isSupported('FAQPage')).toBe(true)
  })

  it('isSupported 对未知类型返回 false', () => {
    expect(registry.isSupported('UnknownType')).toBe(false)
    expect(registry.isSupported('')).toBe(false)
  })

  it('get 返回已知类型的字段定义', () => {
    const def = registry.get('SoftwareApplication')
    expect(def).not.toBeNull()
    expect(def!.requiredFields).toEqual(['name', 'applicationCategory'])
    expect(def!.optionalFields).toContain('description')
  })

  it('get 对未知类型返回 null', () => {
    expect(registry.get('Unknown')).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/schema-generator/schema-registry.test.ts`
预期：FAIL，模块找不到。

- [ ] **步骤 3：编写实现**

创建 `src/modules/schema-generator/schema-registry.ts`：

```typescript
import type { SupportedSchemaType, SchemaTypeDefinition } from './types.js'

export const SUPPORTED_TYPES: SupportedSchemaType[] = [
  'SoftwareApplication',
  'Organization',
  'Product',
  'FAQPage',
  'Article',
  'BreadcrumbList',
]

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

export interface SchemaRegistryService {
  get(type: string): SchemaTypeDefinition | null
  isSupported(type: string): boolean
  list(): SupportedSchemaType[]
}

export function createSchemaRegistry(): SchemaRegistryService {
  return {
    get(type) {
      return (SCHEMA_TYPES as Record<string, SchemaTypeDefinition | undefined>)[type] ?? null
    },
    isSupported(type) {
      return type in SCHEMA_TYPES
    },
    list() {
      return [...SUPPORTED_TYPES]
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/schema-generator/schema-registry.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/schema-generator/schema-registry.ts src/modules/schema-generator/schema-registry.test.ts
git commit -m "feat(schema-generator): add SchemaRegistry with 6-type whitelist"
```

---

## 任务 5：JsonLdBuilder（纯函数 JSON-LD 组装）

**文件：**
- 创建：`src/modules/schema-generator/jsonld-builder.ts`
- 测试：`src/modules/schema-generator/jsonld-builder.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/schema-generator/jsonld-builder.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { createJsonLdBuilder } from './jsonld-builder.js'
import { createSchemaRegistry } from './schema-registry.js'

describe('JsonLdBuilder', () => {
  const builder = createJsonLdBuilder()
  const registry = createSchemaRegistry()

  it('build 注入 @context 和 @type', () => {
    const doc = builder.build({
      type: 'SoftwareApplication',
      fields: { name: 'zoomer AI', applicationCategory: 'DesignApplication' },
    })
    expect(doc['@context']).toBe('https://schema.org')
    expect(doc['@type']).toBe('SoftwareApplication')
  })

  it('build 保留所有白名单内字段', () => {
    const doc = builder.build({
      type: 'SoftwareApplication',
      fields: {
        name: 'zoomer AI',
        applicationCategory: 'DesignApplication',
        description: 'AI 设计工具',
        operatingSystem: 'Web',
      },
    })
    expect(doc['name']).toBe('zoomer AI')
    expect(doc['applicationCategory']).toBe('DesignApplication')
    expect(doc['description']).toBe('AI 设计工具')
    expect(doc['operatingSystem']).toBe('Web')
  })

  it('build 过滤掉白名单外的字段', () => {
    const doc = builder.build({
      type: 'SoftwareApplication',
      fields: {
        name: 'zoomer AI',
        applicationCategory: 'DesignApplication',
        unknownField: 'should be dropped',
      },
    })
    expect((doc as any).unknownField).toBeUndefined()
  })

  it('build 必填字段缺失时抛错', () => {
    expect(() =>
      builder.build({
        type: 'SoftwareApplication',
        fields: { name: 'zoomer AI' },
      }),
    ).toThrow(/applicationCategory/)
  })

  it('build 对未知 type 抛错', () => {
    expect(() =>
      builder.build({
        type: 'UnknownType' as any,
        fields: { name: 'x' },
      }),
    ).toThrow(/UnknownType/)
  })

  it('registry.get 与 builder 行为一致', () => {
    expect(registry.get('SoftwareApplication')).not.toBeNull()
    expect(registry.get('Unknown')).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/schema-generator/jsonld-builder.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/modules/schema-generator/jsonld-builder.ts`：

```typescript
import type { JsonLdDocument, SupportedSchemaType } from './types.js'
import { createSchemaRegistry } from './schema-registry.js'

export class MissingRequiredFieldError extends Error {
  constructor(public type: SupportedSchemaType, public field: string) {
    super(`Missing required field "${field}" for schema type "${type}"`)
    this.name = 'MissingRequiredFieldError'
  }
}

export class UnsupportedSchemaTypeError extends Error {
  constructor(public type: string) {
    super(`Unsupported schema type: "${type}"`)
    this.name = 'UnsupportedSchemaTypeError'
  }
}

export interface JsonLdBuilderService {
  build(input: { type: SupportedSchemaType; fields: Record<string, unknown> }): JsonLdDocument
}

export function createJsonLdBuilder() {
  const registry = createSchemaRegistry()

  return {
    build(input) {
      const def = registry.get(input.type)
      if (!def) throw new UnsupportedSchemaTypeError(input.type)

      // 校验必填字段
      for (const field of def.requiredFields) {
        const v = input.fields[field]
        if (v === undefined || v === null || v === '') {
          throw new MissingRequiredFieldError(input.type, field)
        }
      }

      // 过滤字段（仅保留 required + optional）
      const allowed = new Set([...def.requiredFields, ...def.optionalFields])
      const filtered: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input.fields)) {
        if (allowed.has(k)) filtered[k] = v
      }

      return {
        '@context': 'https://schema.org',
        '@type': input.type,
        ...filtered,
      } as JsonLdDocument
    },
  } satisfies JsonLdBuilderService
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/schema-generator/jsonld-builder.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/schema-generator/jsonld-builder.ts src/modules/schema-generator/jsonld-builder.test.ts
git commit -m "feat(schema-generator): add JsonLdBuilder with whitelist field filtering"
```

---

## 任务 6：LlmsTxtBuilder（llms.txt markdown 组装）

**文件：**
- 创建：`src/modules/schema-generator/llms-txt-builder.ts`
- 测试：`src/modules/schema-generator/llms-txt-builder.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/schema-generator/llms-txt-builder.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { createLlmsTxtBuilder } from './llms-txt-builder.js'

describe('LlmsTxtBuilder', () => {
  const builder = createLlmsTxtBuilder()

  it('build 输出标准 markdown 格式', () => {
    const md = builder.build({
      brandName: 'zoomer AI',
      tagline: 'AI 设计工具',
      sections: [
        {
          title: '核心产品',
          items: [
            { label: '白模生图', url: 'https://example.com/feature-1', description: '一键生成白模线稿' },
            { label: '智能填充', url: 'https://example.com/feature-2', description: 'AI 智能填充内容' },
          ],
        },
        {
          title: '常见问答',
          items: [
            { label: 'Q1: 什么是 zoomer AI?', url: '#', description: 'A: 是一款 AI 设计工具' },
          ],
        },
      ],
      updateFrequency: { docs: '每周', blog: '每周 2 篇' },
    })

    expect(md).toContain('# zoomer AI')
    expect(md).toContain('> AI 设计工具')
    expect(md).toContain('## 核心产品')
    expect(md).toContain('- [白模生图](https://example.com/feature-1): 一键生成白模线稿')
    expect(md).toContain('## 常见问答')
    expect(md).toContain('## 更新频率')
    expect(md).toContain('- 文档：每周')
    expect(md).toContain('- 博客：每周 2 篇')
  })

  it('build 不传 updateFrequency 时跳过该 section', () => {
    const md = builder.build({
      brandName: 'zoomer AI',
      tagline: 'AI 设计工具',
      sections: [{ title: '核心产品', items: [] }],
    })
    expect(md).not.toContain('## 更新频率')
  })

  it('build 空 sections 时仍输出品牌行', () => {
    const md = builder.build({
      brandName: 'zoomer',
      tagline: 't',
      sections: [],
    })
    expect(md).toContain('# zoomer')
    expect(md).toContain('> t')
  })

  it('parseMarkdown 回读 build 结果', () => {
    const original = {
      brandName: 'zoomer AI',
      tagline: 'AI 设计工具',
      sections: [
        {
          title: '核心产品',
          items: [{ label: '白模', url: 'https://x.com', description: 'desc' }],
        },
      ],
    }
    const md = builder.build(original)
    const parsed = builder.parseMarkdown(md)
    expect(parsed).not.toBeNull()
    expect(parsed!.brandName).toBe('zoomer AI')
    expect(parsed!.tagline).toBe('AI 设计工具')
    expect(parsed!.sections[0].items[0].url).toBe('https://x.com')
  })

  it('parseMarkdown 对非法输入返回 null', () => {
    expect(builder.parseMarkdown('')).toBeNull()
    expect(builder.parseMarkdown('random text')).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/schema-generator/llms-txt-builder.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/modules/schema-generator/llms-txt-builder.ts`：

```typescript
import type { LlmsTxtInput, LlmsTxtSection } from './types.js'

export interface LlmsTxtBuilderService {
  build(input: LlmsTxtInput): string
  parseMarkdown(md: string): LlmsTxtInput | null
}

export function createLlmsTxtBuilder(): LlmsTxtBuilderService {
  return {
    build(input) {
      const lines: string[] = []
      lines.push(`# ${input.brandName}`)
      lines.push(`> ${input.tagline}`)
      lines.push('')

      for (const section of input.sections) {
        lines.push(`## ${section.title}`)
        for (const item of section.items) {
          lines.push(`- [${item.label}](${item.url}): ${item.description}`)
        }
        lines.push('')
      }

      if (input.updateFrequency) {
        lines.push('## 更新频率')
        if (input.updateFrequency.docs) {
          lines.push(`- 文档：${input.updateFrequency.docs}`)
        }
        if (input.updateFrequency.blog) {
          lines.push(`- 博客：${input.updateFrequency.blog}`)
        }
        lines.push('')
      }

      return lines.join('\n').trimEnd() + '\n'
    },

    parseMarkdown(md) {
      const trimmed = md.trim()
      if (!trimmed.startsWith('# ')) return null

      const lines = trimmed.split('\n')
      const brandName = lines[0].slice(2).trim()
      const taglineLine = lines.find((l) => l.startsWith('> '))
      if (!taglineLine) return null
      const tagline = taglineLine.slice(2).trim()

      const sections: LlmsTxtSection[] = []
      let currentSection: LlmsTxtSection | null = null
      let updateFrequency: { docs?: string; blog?: string } | undefined

      for (const line of lines.slice(1)) {
        if (line.startsWith('## ')) {
          const title = line.slice(3).trim()
          if (title === '更新频率') {
            currentSection = null
            updateFrequency = {}
          } else {
            currentSection = { title, items: [] }
            sections.push(currentSection)
          }
        } else if (line.startsWith('- ') && currentSection) {
          const m = line.slice(2).match(/^\[([^\]]+)\]\(([^)]+)\):\s*(.+)$/)
          if (m) {
            currentSection.items.push({ label: m[1], url: m[2], description: m[3] })
          }
        } else if (line.startsWith('- ') && updateFrequency) {
          const m = line.slice(2).match(/^(文档|博客)：(.+)$/)
          if (m) {
            if (m[1] === '文档') updateFrequency.docs = m[2]
            if (m[1] === '博客') updateFrequency.blog = m[2]
          }
        }
      }

      return { brandName, tagline, sections, updateFrequency }
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/schema-generator/llms-txt-builder.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/schema-generator/llms-txt-builder.ts src/modules/schema-generator/llms-txt-builder.test.ts
git commit -m "feat(schema-generator): add LlmsTxtBuilder with markdown assemble and parse"
```

---

## 任务 7：SchemaValidator（schema.org 校验）

**文件：**
- 创建：`src/modules/schema-generator/validator.ts`
- 测试：`src/modules/schema-generator/validator.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/schema-generator/validator.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { createSchemaValidator } from './validator.js'
import { createSchemaRegistry } from './schema-registry.js'

describe('SchemaValidator', () => {
  const validator = createSchemaValidator(createSchemaRegistry())

  it('合法 JSON-LD 返回 valid: true', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'zoomer AI',
      applicationCategory: 'DesignApplication',
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('@context 错误返回 INVALID_CONTEXT', () => {
    const result = validator.validate({
      '@context': 'https://example.com',
      '@type': 'SoftwareApplication',
      name: 'x',
      applicationCategory: 'y',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_CONTEXT')).toBe(true)
  })

  it('@type 不在白名单返回 INVALID_TYPE', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'UnknownType',
      name: 'x',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true)
  })

  it('必填字段缺失返回 MISSING_REQUIRED', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'x',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MISSING_REQUIRED' && e.path === 'applicationCategory')).toBe(true)
  })

  it('多重错误同时报告', () => {
    const result = validator.validate({
      '@context': 'https://example.com',
      '@type': 'UnknownType',
    })
    expect(result.valid).toBe(false)
    const codes = result.errors.map((e) => e.code)
    expect(codes).toContain('INVALID_CONTEXT')
    expect(codes).toContain('INVALID_TYPE')
  })

  it('非对象输入返回 INVALID_CONTEXT', () => {
    const result = validator.validate(null)
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('INVALID_CONTEXT')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/schema-generator/validator.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/modules/schema-generator/validator.ts`：

```typescript
import type { ValidationResult, ValidationError } from './types.js'
import type { SchemaRegistryService } from './schema-registry.js'

export interface SchemaValidatorService {
  validate(doc: unknown): ValidationResult
}

export function createSchemaValidator(registry: SchemaRegistryService): SchemaValidatorService {
  return {
    validate(doc) {
      const errors: ValidationError[] = []

      if (!doc || typeof doc !== 'object') {
        errors.push({ path: '@context', message: 'Document must be an object', code: 'INVALID_CONTEXT' })
        return { valid: false, errors }
      }

      const obj = doc as Record<string, unknown>

      if (obj['@context'] !== 'https://schema.org') {
        errors.push({ path: '@context', message: '@context must be "https://schema.org"', code: 'INVALID_CONTEXT' })
      }

      const type = obj['@type']
      if (typeof type !== 'string' || !registry.isSupported(type)) {
        errors.push({ path: '@type', message: `Unsupported schema type: ${String(type)}`, code: 'INVALID_TYPE' })
        return { valid: false, errors }
      }

      const def = registry.get(type)!
      for (const field of def.requiredFields) {
        const v = obj[field]
        if (v === undefined || v === null || v === '') {
          errors.push({
            path: field,
            message: `Missing required field "${field}" for type "${type}"`,
            code: 'MISSING_REQUIRED',
          })
        }
      }

      return { valid: errors.length === 0, errors }
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/schema-generator/validator.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/schema-generator/validator.ts src/modules/schema-generator/validator.test.ts
git commit -m "feat(schema-generator): add SchemaValidator with multi-rule validation"
```

---

## 任务 8：SchemaTypeAdapter（RawEntity → SchemaEntity）

**文件：**
- 创建：`src/core/extract/adapters/schema-adapter.ts`
- 测试：`src/core/extract/adapters/schema-adapter.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/core/extract/adapters/schema-adapter.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { createSchemaAdapter } from './schema-adapter.js'
import { createSchemaRegistry } from '../../schema-generator/schema-registry.js'
import type { RawEntity } from '../types.js'

describe('SchemaTypeAdapter', () => {
  const adapter = createSchemaAdapter(createSchemaRegistry())

  it('rawType 含"工具"/"app" → SoftwareApplication', () => {
    const result = adapter.adapt([
      { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { name: 'zoomer AI' } },
      { name: 'X', rawType: 'mobile app', properties: { name: 'X' } },
    ])
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('SoftwareApplication')
    expect(result[1].type).toBe('SoftwareApplication')
  })

  it('rawType 含"公司"/"company" → Organization', () => {
    const result = adapter.adapt([
      { name: 'Acme', rawType: 'SaaS company', properties: { name: 'Acme', url: 'https://acme.com' } },
    ])
    expect(result[0].type).toBe('Organization')
  })

  it('rawType 含"产品"/"product" → Product', () => {
    const result = adapter.adapt([
      { name: 'Pro', rawType: '产品', properties: { name: 'Pro' } },
    ])
    expect(result[0].type).toBe('Product')
  })

  it('rawType 含"faq"/"问答" → FAQPage', () => {
    const result = adapter.adapt([
      { name: 'FAQ', rawType: 'faq 列表', properties: { mainEntity: [] } },
    ])
    expect(result[0].type).toBe('FAQPage')
  })

  it('rawType 含"article"/"文章" → Article', () => {
    const result = adapter.adapt([
      { name: 'post', rawType: 'blog article', properties: { headline: 't', author: 'a' } },
    ])
    expect(result[0].type).toBe('Article')
  })

  it('rawType 含"breadcrumb"/"面包屑" → BreadcrumbList', () => {
    const result = adapter.adapt([
      { name: 'crumbs', rawType: 'breadcrumb 导航', properties: { itemListElement: [] } },
    ])
    expect(result[0].type).toBe('BreadcrumbList')
  })

  it('未匹配的 rawType 被跳过（不抛错）', () => {
    const result = adapter.adapt([
      { name: 'unknown', rawType: '杂七杂八的东西', properties: {} },
      { name: 'zoomer', rawType: 'AI 工具', properties: { name: 'zoomer' } },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('zoomer')
  })

  it('过滤掉不在白名单的 properties 字段', () => {
    const result = adapter.adapt([
      {
        name: 'zoomer',
        rawType: 'AI 工具',
        properties: { name: 'zoomer', applicationCategory: 'DesignApp', extra: 'drop me' },
      },
    ])
    expect((result[0].fields as any).extra).toBeUndefined()
    expect((result[0].fields as any).name).toBe('zoomer')
    expect((result[0].fields as any).applicationCategory).toBe('DesignApp')
  })

  it('空数组输入返回空数组', () => {
    expect(adapter.adapt([])).toEqual([])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/core/extract/adapters/schema-adapter.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/core/extract/adapters/schema-adapter.ts`：

```typescript
import type { RawEntity, TypeAdapter } from '../types.js'
import type { SchemaEntity, SupportedSchemaType } from '../../../modules/schema-generator/types.js'
import type { SchemaRegistryService } from '../../../modules/schema-generator/schema-registry.js'

interface TypeKeyword {
  type: SupportedSchemaType
  keywords: RegExp[]
}

const KEYWORD_RULES: TypeKeyword[] = [
  {
    type: 'SoftwareApplication',
    keywords: [/\bapp\b/i, /\bsoftware\b/i, /工具/, /应用/, /小程序/, /tool/i],
  },
  {
    type: 'Organization',
    keywords: [/\bcompany\b/i, /\borg(anization)?\b/i, /公司/, /组织/, /企业/, /团队/],
  },
  {
    type: 'Product',
    keywords: [/\bproduct\b/i, /产品/, /商品/],
  },
  {
    type: 'FAQPage',
    keywords: [/\bfaq\b/i, /问答/, /常见问题/],
  },
  {
    type: 'Article',
    keywords: [/\barticle\b/i, /\bblog\b/i, /\bpost\b/i, /文章/, /博客/],
  },
  {
    type: 'BreadcrumbList',
    keywords: [/\bbreadcrumb\b/i, /面包屑/],
  },
]

export interface SchemaAdapterService {
  adapt(raw: RawEntity[]): SchemaEntity[]
}

export function createSchemaAdapter(registry: SchemaRegistryService): SchemaAdapterService & TypeAdapter<SchemaEntity> {
  function mapType(rawType: string): SupportedSchemaType | null {
    for (const rule of KEYWORD_RULES) {
      if (rule.keywords.some((kw) => kw.test(rawType))) return rule.type
    }
    return null
  }

  function filterFields(type: SupportedSchemaType, props: Record<string, unknown>): Record<string, unknown> {
    const def = registry.get(type)
    if (!def) return {}
    const allowed = new Set([...def.requiredFields, ...def.optionalFields])
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      if (allowed.has(k)) out[k] = v
    }
    return out
  }

  return {
    adapt(raw) {
      const out: SchemaEntity[] = []
      for (const entity of raw) {
        const type = mapType(entity.rawType)
        if (!type) continue
        out.push({ type, fields: filterFields(type, entity.properties) })
      }
      return out
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/core/extract/adapters/schema-adapter.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/core/extract/adapters/schema-adapter.ts src/core/extract/adapters/schema-adapter.test.ts
git commit -m "feat(extract): add SchemaTypeAdapter with keyword-based type mapping"
```

---

## 任务 9：KgTypeAdapter（RawEntity → KgEntityDraft）

**文件：**
- 创建：`src/core/extract/adapters/kg-adapter.ts`
- 测试：`src/core/extract/adapters/kg-adapter.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/core/extract/adapters/kg-adapter.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { createKgAdapter } from './kg-adapter.js'
import type { RawEntity } from '../types.js'

describe('KgTypeAdapter', () => {
  const adapter = createKgAdapter()

  it('保留所有 RawEntity 直接转换为 KgEntityDraft', () => {
    const result = adapter.adapt([
      { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { url: 'https://x.com' } },
      { name: 'Notion', rawType: '笔记软件', properties: { founded: 2016 } },
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      name: 'zoomer AI',
      type: 'AI 设计工具',
      properties: { url: 'https://x.com' },
    })
    expect(result[1].type).toBe('笔记软件')
  })

  it('不丢弃未匹配的 rawType（KG 类型不受限）', () => {
    const result = adapter.adapt([
      { name: '奇怪实体', rawType: '无法识别的类型', properties: { foo: 'bar' } },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('无法识别的类型')
  })

  it('properties 字段全部保留', () => {
    const result = adapter.adapt([
      {
        name: 'x',
        rawType: 't',
        properties: { a: 1, b: true, c: 'str', d: [1, 2], e: { nested: true } },
      },
    ])
    expect(result[0].properties).toEqual({ a: 1, b: true, c: 'str', d: [1, 2], e: { nested: true } })
  })

  it('空数组输入返回空数组', () => {
    expect(adapter.adapt([])).toEqual([])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/core/extract/adapters/kg-adapter.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/core/extract/adapters/kg-adapter.ts`：

```typescript
import type { RawEntity, TypeAdapter } from '../types.js'
import type { KgEntityDraft } from '../../../modules/knowledge-graph/types.js'

export interface KgAdapterService {
  adapt(raw: RawEntity[]): KgEntityDraft[]
}

export function createKgAdapter(): KgAdapterService & TypeAdapter<KgEntityDraft> {
  return {
    adapt(raw) {
      return raw.map((e) => ({
        name: e.name,
        type: e.rawType,
        properties: e.properties,
      }))
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/core/extract/adapters/kg-adapter.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/core/extract/adapters/kg-adapter.ts src/core/extract/adapters/kg-adapter.test.ts
git commit -m "feat(extract): add KgTypeAdapter for unrestricted KG type mapping"
```

---

## 任务 10：EntityExtractor（LLM 抽取原始实体）

**文件：**
- 创建：`src/core/extract/entity-extractor.ts`
- 测试：`src/core/extract/entity-extractor.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/core/extract/entity-extractor.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createEntityExtractor } from './entity-extractor.js'
import type { LlmProvider } from '../llm/types.js'

function mockLlm(responseText: string): LlmProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseText }),
    embed: vi.fn(),
  }
}

describe('EntityExtractor', () => {
  it('解析 LLM 返回的合法 JSON', async () => {
    const llmResponse = JSON.stringify({
      entities: [
        { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { url: 'https://x.com' } },
      ],
      relations: [{ fromName: 'zoomer AI', toName: 'Notion', relationType: 'competitor' }],
    })
    const extractor = createEntityExtractor(mockLlm(llmResponse))
    const result = await extractor.extract('zoomer AI 是 AI 设计工具')
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0].name).toBe('zoomer AI')
    expect(result.relations[0].relationType).toBe('competitor')
  })

  it('LLM 返回非 JSON 时兜底返回空结果', async () => {
    const extractor = createEntityExtractor(mockLlm('这不是 JSON'))
    const result = await extractor.extract('content')
    expect(result.entities).toEqual([])
    expect(result.relations).toEqual([])
    expect(result.extractionNotes).toBe('parse_failed')
  })

  it('JSON 缺少 entities 字段时兜底返回空数组', async () => {
    const extractor = createEntityExtractor(mockLlm(JSON.stringify({ wrong: 'shape' })))
    const result = await extractor.extract('content')
    expect(result.entities).toEqual([])
    expect(result.relations).toEqual([])
    expect(result.extractionNotes).toBe('parse_failed')
  })

  it('使用 temperature: 0 调用 LLM', async () => {
    const llm = mockLlm(JSON.stringify({ entities: [], relations: [] }))
    const extractor = createEntityExtractor(llm)
    await extractor.extract('test')
    expect(llm.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ temperature: 0 }),
    )
  })

  it('空内容不调用 LLM，直接返回空结果', async () => {
    const llm = mockLlm('')
    const extractor = createEntityExtractor(llm)
    const result = await extractor.extract('')
    expect(result.entities).toEqual([])
    expect(result.relations).toEqual([])
    expect(llm.chat).not.toHaveBeenCalled()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/core/extract/entity-extractor.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/core/extract/entity-extractor.ts`：

```typescript
import type { LlmProvider } from '../llm/types.js'
import type { ExtractionResult, RawEntity, RawRelation } from './types.js'

const SYSTEM_PROMPT = `你是一个实体抽取专家。从用户给的内容中抽取所有命名实体和实体之间的关系。

实体字段：
- name: 实体名（产品名、公司名、人名等）
- rawType: 实体的原始类型描述，如 "AI 设计工具"、"SaaS 公司"、"笔记软件"
- properties: 实体的关键属性（URL、描述、数字等），保持 JSON 结构

关系字段：
- fromName: 起始实体名
- toName: 目标实体名
- relationType: 关系类型，如 "competitor"、"hasFeature"、"belongsTo"
- properties: 关系的附加属性（可选）

要求：
1. 抽取所有有意义的命名实体（包括产品、公司、人物、概念）
2. 推断实体间的关系（同行业、上下游、包含等）
3. 不要抽取泛指词（如"工具"、"产品"作为单独实体）

只输出 JSON，格式：{ "entities": [...], "relations": [...] }`

export interface EntityExtractorService {
  extract(content: string): Promise<ExtractionResult>
}

export function createEntityExtractor(llm: LlmProvider): EntityExtractorService {
  return {
    async extract(content) {
      if (!content || content.trim().length === 0) {
        return { entities: [], relations: [], extractionNotes: 'empty_input' }
      }

      const res = await llm.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        { temperature: 0 },
      )

      return parseExtraction(res.text)
    },
  }
}

function parseExtraction(raw: string): ExtractionResult {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.entities) && Array.isArray(parsed.relations)) {
      const entities: RawEntity[] = parsed.entities.map((e: any) => ({
        name: String(e.name || ''),
        rawType: String(e.rawType || ''),
        properties: typeof e.properties === 'object' && e.properties !== null ? e.properties : {},
        sourceSpan: e.sourceSpan,
      }))
      const relations: RawRelation[] = parsed.relations.map((r: any) => ({
        fromName: String(r.fromName || ''),
        toName: String(r.toName || ''),
        relationType: String(r.relationType || ''),
        properties: typeof r.properties === 'object' && r.properties !== null ? r.properties : undefined,
      }))
      return { entities, relations, extractionNotes: parsed.extractionNotes }
    }
  } catch {
    // 兜底
  }

  return { entities: [], relations: [], extractionNotes: 'parse_failed' }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/core/extract/entity-extractor.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/core/extract/entity-extractor.ts src/core/extract/entity-extractor.test.ts
git commit -m "feat(extract): add EntityExtractor with LLM extraction and JSON parsing"
```

---

## 任务 11：KgRepository（Prisma CRUD）

**文件：**
- 创建：`src/modules/knowledge-graph/repository.ts`
- 测试：`src/modules/knowledge-graph/repository.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/knowledge-graph/repository.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createKgRepository, DuplicateEntityError, EntityNotFoundError } from './repository.js'
import type { PrismaClient } from '@prisma/client'

function mockPrisma() {
  const entities = new Map<string, any>([
    ['w1::zoomer-ai', { id: 'e1', workspaceId: 'w1', name: 'zoomer AI', type: 'SoftwareApplication', properties: {} }],
  ])
  return {
    kgEntity: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        const key = `${where.workspaceId_name?.workspaceId}::${where.workspaceId_name?.name}`
        return entities.get(key) ?? (where.id ? entities.get(`w1::${where.id}`) : null)
      }),
      findMany: vi.fn().mockResolvedValue(Array.from(entities.values())),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        const id = `e-${Math.random()}`
        const entity = { id, ...data }
        entities.set(`${data.workspaceId}::${data.name}`, entity)
        return entity
      }),
      delete: vi.fn().mockResolvedValue({}),
    },
    kgRelation: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data })),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient
}

describe('KgRepository', () => {
  it('addEntity 插入新实体', async () => {
    const repo = createKgRepository(mockPrisma())
    const entity = await repo.addEntity({
      workspaceId: 'w1', name: 'NewEntity', type: 'Product', properties: {},
    })
    expect(entity.id).toBeDefined()
    expect(entity.name).toBe('NewEntity')
  })

  it('addEntity 重复 name 时抛 DuplicateEntityError', async () => {
    const repo = createKgRepository(mockPrisma())
    await expect(
      repo.addEntity({ workspaceId: 'w1', name: 'zoomer AI', type: 'X', properties: {} }),
    ).rejects.toThrow(DuplicateEntityError)
  })

  it('findEntityByName 返回已知实体', async () => {
    const repo = createKgRepository(mockPrisma())
    const entity = await repo.findEntityByName('w1', 'zoomer AI')
    expect(entity?.id).toBe('e1')
  })

  it('findEntityByName 对未知实体返回 null', async () => {
    const repo = createKgRepository(mockPrisma())
    expect(await repo.findEntityByName('w1', 'unknown')).toBeNull()
  })

  it('findEntities 按 workspace 查询', async () => {
    const repo = createKgRepository(mockPrisma())
    const list = await repo.findEntities('w1')
    expect(list.length).toBeGreaterThanOrEqual(1)
  })

  it('addRelation 在两端实体都存在时成功', async () => {
    const prisma = mockPrisma()
    const repo = createKgRepository(prisma)
    // 先添加两个实体
    await repo.addEntity({ workspaceId: 'w1', name: 'A', type: 'X', properties: {} })
    await repo.addEntity({ workspaceId: 'w1', name: 'B', type: 'X', properties: {} })
    const rel = await repo.addRelation({ fromName: 'A', toName: 'B', relationType: 'competitor' })
    expect(rel.id).toBeDefined()
  })

  it('addRelation 任一端实体不存在时抛 EntityNotFoundError', async () => {
    const repo = createKgRepository(mockPrisma())
    await expect(
      repo.addRelation({ fromName: 'missing', toName: 'B', relationType: 'competitor' }),
    ).rejects.toThrow(EntityNotFoundError)
  })

  it('removeEntity 调用 prisma.delete', async () => {
    const prisma = mockPrisma()
    const repo = createKgRepository(prisma)
    await repo.removeEntity('e1')
    expect((prisma.kgEntity as any).delete).toHaveBeenCalledWith({ where: { id: 'e1' } })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/knowledge-graph/repository.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/modules/knowledge-graph/repository.ts`：

```typescript
import type { PrismaClient, KgEntity, KgRelation } from '@prisma/client'

export class DuplicateEntityError extends Error {
  constructor(public workspaceId: string, public name: string) {
    super(`KgEntity already exists: workspaceId="${workspaceId}" name="${name}"`)
    this.name = 'DuplicateEntityError'
  }
}

export class EntityNotFoundError extends Error {
  constructor(public workspaceId: string, public name: string) {
    super(`KgEntity not found: workspaceId="${workspaceId}" name="${name}"`)
    this.name = 'EntityNotFoundError'
  }
}

export interface KgRepositoryService {
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
  removeEntity(id: string): Promise<void>

  findRelations(opts: { fromId?: string; toId?: string }): Promise<KgRelation[]>
  addRelation(input: {
    fromName: string
    toName: string
    relationType: string
    properties?: Record<string, unknown>
  }): Promise<KgRelation>
}

export function createKgRepository(prisma: PrismaClient): KgRepositoryService {
  return {
    async findEntityByName(workspaceId, name) {
      return prisma.kgEntity.findUnique({
        where: { workspaceId_name: { workspaceId, name } },
      })
    },

    async findEntityById(id) {
      return prisma.kgEntity.findUnique({ where: { id } })
    },

    async findEntities(workspaceId, opts) {
      const where: any = { workspaceId }
      if (opts?.type) where.type = opts.type
      return prisma.kgEntity.findMany({ where })
    },

    async addEntity(input) {
      const existing = await prisma.kgEntity.findUnique({
        where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.name } },
      })
      if (existing) throw new DuplicateEntityError(input.workspaceId, input.name)
      return prisma.kgEntity.create({ data: input })
    },

    async removeEntity(id) {
      await prisma.kgEntity.delete({ where: { id } })
    },

    async findRelations(opts) {
      const where: any = {}
      if (opts.fromId) where.fromEntityId = opts.fromId
      if (opts.toId) where.toEntityId = opts.toId
      return prisma.kgRelation.findMany({ where })
    },

    async addRelation(input) {
      const [from, to] = await Promise.all([
        prisma.kgEntity.findUnique({
          where: { workspaceId_name: { workspaceId: await resolveWorkspaceId(input.fromName, prisma), name: input.fromName } },
        }),
        prisma.kgEntity.findUnique({
          where: { workspaceId_name: { workspaceId: await resolveWorkspaceId(input.toName, prisma), name: input.toName } },
        }),
      ])
      if (!from) throw new EntityNotFoundError(from?.workspaceId ?? '', input.fromName)
      if (!to) throw new EntityNotFoundError(to?.workspaceId ?? '', input.toName)

      return prisma.kgRelation.create({
        data: {
          fromEntityId: from.id,
          toEntityId: to.id,
          relationType: input.relationType,
          properties: (input.properties as any) ?? {},
        },
      })
    },
  }
}

// 辅助：先 findUnique 已存在的实体拿 workspaceId
async function resolveWorkspaceId(name: string, prisma: PrismaClient): Promise<string> {
  const found = await prisma.kgEntity.findFirst({ where: { name } })
  return found?.workspaceId ?? ''
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/knowledge-graph/repository.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/knowledge-graph/repository.ts src/modules/knowledge-graph/repository.test.ts
git commit -m "feat(knowledge-graph): add KgRepository with CRUD and duplicate detection"
```

---

## 任务 12：AutoSections（autoBuildSections 辅助）

**文件：**
- 创建：`src/modules/schema-generator/auto-sections.ts`
- 测试：`src/modules/schema-generator/auto-sections.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/schema-generator/auto-sections.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createAutoSections } from './auto-sections.js'
import type { PrismaClient } from '@prisma/client'

function mockPrisma(opts: {
  entities?: any[]
  pages?: any[]
} = {}) {
  return {
    kgEntity: {
      findMany: vi.fn().mockResolvedValue(opts.entities ?? []),
    },
    contentPage: {
      findMany: vi.fn().mockResolvedValue(opts.pages ?? []),
    },
  } as unknown as PrismaClient
}

describe('AutoSections', () => {
  it('从 KG 实体（SoftwareApplication/Product）收集核心产品 section', async () => {
    const prisma = mockPrisma({
      entities: [
        { name: 'zoomer AI', type: 'SoftwareApplication', properties: { url: 'https://x.com/zoomer' } },
        { name: 'Pro Plan', type: 'Product', properties: { url: 'https://x.com/pro' } },
        { name: 'Acme Co', type: 'Organization', properties: {} },  // 不应被收集
      ],
    })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    const productSection = result.sections.find((s) => s.title === '核心产品')
    expect(productSection).toBeDefined()
    expect(productSection!.items).toHaveLength(2)
    expect(productSection!.items.map((i) => i.label)).toContain('zoomer AI')
  })

  it('从 ContentPage（blog/docs）收集权威资源 section', async () => {
    const prisma = mockPrisma({
      pages: [
        { url: 'https://x.com/blog/1', pageType: 'blog' },
        { url: 'https://x.com/docs/intro', pageType: 'docs' },
        { url: 'https://x.com/landing', pageType: 'landing' },
      ],
    })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    const resourcesSection = result.sections.find((s) => s.title === '权威资源')
    expect(resourcesSection).toBeDefined()
    expect(resourcesSection!.items).toHaveLength(2)
  })

  it('从 ContentPage.optimizedContent 解析 FaqPair 收集常见问答 section', async () => {
    const faqResult = {
      faqs: [
        { question: '什么是 zoomer AI?', answer: '是 AI 设计工具' },
        { question: '价格如何?', answer: '免费' },
      ],
    }
    const prisma = mockPrisma({
      pages: [
        { url: 'https://x.com/landing', pageType: 'landing', optimizedContent: JSON.stringify(faqResult) },
      ],
    })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    const faqSection = result.sections.find((s) => s.title === '常见问答')
    expect(faqSection).toBeDefined()
    expect(faqSection!.items).toHaveLength(2)
  })

  it('数据源缺失时收集 warnings', async () => {
    const prisma = mockPrisma({ entities: [], pages: [] })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.some((w) => w.includes('核心产品'))).toBe(true)
  })

  it('optimizedContent 不是 JSON 时不抛错', async () => {
    const prisma = mockPrisma({
      pages: [{ url: 'https://x.com/landing', pageType: 'landing', optimizedContent: 'not json' }],
    })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    expect(result.warnings.some((w) => w.includes('FAQ'))).toBe(true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/schema-generator/auto-sections.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/modules/schema-generator/auto-sections.ts`：

```typescript
import type { PrismaClient } from '@prisma/client'
import type { AutoSectionsResult, LlmsTxtSection } from './types.js'

export interface AutoSectionsService {
  buildSections(workspaceId: string): Promise<AutoSectionsResult>
}

const PRODUCT_TYPES = ['SoftwareApplication', 'Product']
const RESOURCE_PAGE_TYPES = ['blog', 'docs', 'whitepaper']

export function createAutoSections(deps: { prisma: PrismaClient }): AutoSectionsService {
  return {
    async buildSections(workspaceId) {
      const warnings: string[] = []
      const sections: LlmsTxtSection[] = []

      // 1. 核心产品（KG 实体）
      const entities = await deps.prisma.kgEntity.findMany({
        where: { workspaceId, type: { in: PRODUCT_TYPES } },
      })
      if (entities.length === 0) {
        warnings.push('核心产品 section：workspace 中没有 SoftwareApplication 或 Product 类型实体')
      } else {
        sections.push({
          title: '核心产品',
          items: entities.map((e) => {
            const props = (e.properties as any) ?? {}
            return {
              label: e.name,
              url: props.url ?? `/${slugify(e.name)}`,
              description: props.description ?? `${e.name} (${e.type})`,
            }
          }),
        })
      }

      // 2. 权威资源（ContentPage）
      const pages = await deps.prisma.contentPage.findMany({
        where: { workspaceId, pageType: { in: RESOURCE_PAGE_TYPES } },
      })
      if (pages.length === 0) {
        warnings.push('权威资源 section：workspace 中没有 blog/docs/whitepaper 类型页面')
      } else {
        sections.push({
          title: '权威资源',
          items: pages.map((p) => ({
            label: p.url,
            url: p.url,
            description: `(${p.pageType})`,
          })),
        })
      }

      // 3. 常见问答（ContentPage.optimizedContent 解析 FaqPair）
      const allPages = await deps.prisma.contentPage.findMany({
        where: { workspaceId, optimizedContent: { not: null } },
      })
      const faqItems: LlmsTxtSection['items'] = []
      for (const p of allPages) {
        try {
          const result = JSON.parse(p.optimizedContent!)
          const faqs = Array.isArray(result?.faqs) ? result.faqs : []
          for (const f of faqs) {
            if (f.question && f.answer) {
              faqItems.push({
                label: `Q: ${f.question}`,
                url: p.url,
                description: `A: ${f.answer}`,
              })
            }
          }
        } catch {
          warnings.push(`常见问答 section：${p.url} 的 optimizedContent 不是合法 JSON`)
        }
      }
      if (faqItems.length === 0) {
        warnings.push('常见问答 section：workspace 中没有可解析的 FAQ 数据')
      } else {
        sections.push({ title: '常见问答', items: faqItems })
      }

      // 4. 更新频率（默认值，后续可配置）
      sections.push({
        title: '更新频率',
        items: [
          { label: '文档', url: '/docs', description: '每周' },
          { label: '博客', url: '/blog', description: '每周 2 篇' },
        ],
      })

      return { sections, warnings }
    },
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/schema-generator/auto-sections.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/schema-generator/auto-sections.ts src/modules/schema-generator/auto-sections.test.ts
git commit -m "feat(schema-generator): add AutoSections with KG/page/FAQ data sources"
```

---

## 任务 13：SchemaService（编排 + SchemaRecord CRUD）

**文件：**
- 创建：`src/modules/schema-generator/service.ts`
- 测试：`src/modules/schema-generator/service.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/schema-generator/service.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createSchemaService } from './service.js'
import type { PrismaClient, SchemaRecord } from '@prisma/client'
import type { EntityExtractorService } from '../../core/extract/entity-extractor.js'
import type { SchemaAdapterService } from '../../core/extract/adapters/schema-adapter.js'
import type { JsonLdBuilderService } from './jsonld-builder.js'
import type { LlmsTxtBuilderService } from './llms-txt-builder.js'
import type { SchemaValidatorService } from './validator.js'
import type { AutoSectionsService } from './auto-sections.js'
import type { SchemaRegistryService } from './schema-registry.js'

function mockPrisma() {
  return {
    schemaRecord: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: `sr-${Math.random()}`,
        ...data,
        createdAt: new Date(),
      })),
      findFirst: vi.fn().mockResolvedValue({ version: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    contentPage: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'page-1',
        url: 'https://x.com/landing',
        currentContent: 'zoomer AI 是 AI 设计工具',
      }),
    },
  } as unknown as PrismaClient
}

function mockDeps(prisma = mockPrisma()) {
  const extractor: EntityExtractorService = {
    extract: vi.fn().mockResolvedValue({
      entities: [
        { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { name: 'zoomer AI', applicationCategory: 'DesignApplication' } },
      ],
      relations: [],
    }),
  }
  const schemaAdapter: SchemaAdapterService = {
    adapt: vi.fn().mockReturnValue([
      { type: 'SoftwareApplication', fields: { name: 'zoomer AI', applicationCategory: 'DesignApplication' } },
    ]),
  }
  const jsonLdBuilder: JsonLdBuilderService = {
    build: vi.fn().mockReturnValue({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'zoomer AI',
      applicationCategory: 'DesignApplication',
    }),
  }
  const llmsTxtBuilder: LlmsTxtBuilderService = {
    build: vi.fn().mockReturnValue('# zoomer AI\n> tagline\n'),
    parseMarkdown: vi.fn(),
  }
  const validator: SchemaValidatorService = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [] }),
  }
  const autoSections: AutoSectionsService = {
    buildSections: vi.fn().mockResolvedValue({ sections: [], warnings: [] }),
  }
  const schemaRegistry: SchemaRegistryService = {
    get: vi.fn(),
    isSupported: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
  }
  return { prisma, extractor, schemaAdapter, jsonLdBuilder, llmsTxtBuilder, validator, autoSections, schemaRegistry }
}

describe('SchemaService', () => {
  it('generateJsonLd 校验 → 写入 → 返回', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    const result = await svc.generateJsonLd({
      workspaceId: 'w1', pageUrl: 'https://x.com/landing',
      schemaType: 'SoftwareApplication',
      fields: { name: 'zoomer AI', applicationCategory: 'DesignApp' },
    })
    expect(result.jsonld['@type']).toBe('SoftwareApplication')
    expect(result.record.id).toBeDefined()
    expect(deps.prisma.schemaRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'w1',
        schemaType: 'SoftwareApplication',
        version: 2,  // 已有 version=1，+1 = 2
      }),
    })
  })

  it('generateJsonLd 校验失败时抛错', async () => {
    const deps = mockDeps()
    ;(deps.validator.validate as any).mockReturnValue({
      valid: false,
      errors: [{ path: 'name', message: 'required', code: 'MISSING_REQUIRED' }],
    })
    const svc = createSchemaService(deps)
    await expect(
      svc.generateJsonLd({
        workspaceId: 'w1', pageUrl: 'https://x.com',
        schemaType: 'SoftwareApplication', fields: {},
      }),
    ).rejects.toThrow()
  })

  it('generateLlmsTxt 输出 markdown 并写入记录', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    const result = await svc.generateLlmsTxt({
      workspaceId: 'w1', brandName: 'zoomer', tagline: 'AI',
      sections: [{ title: '核心产品', items: [] }],
    })
    expect(result.markdown).toContain('# zoomer')
    expect(result.record.schemaType).toBe('LlmsTxt')
  })

  it('regenerateForPage 调用 extractor → adapter → builder → 写入多条记录', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    const records = await svc.regenerateForPage('page-1')
    expect(records.length).toBeGreaterThan(0)
    expect(deps.extractor.extract).toHaveBeenCalled()
    expect(deps.schemaAdapter.adapt).toHaveBeenCalled()
  })

  it('regenerateForPage 校验失败的实体被跳过', async () => {
    const deps = mockDeps()
    ;(deps.validator.validate as any).mockReturnValue({
      valid: false, errors: [{ path: '@type', message: 'bad', code: 'INVALID_TYPE' }],
    })
    const svc = createSchemaService(deps)
    const records = await svc.regenerateForPage('page-1')
    expect(records).toEqual([])
  })

  it('buildAutoSections 透传', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    await svc.buildAutoSections('w1')
    expect(deps.autoSections.buildSections).toHaveBeenCalledWith('w1')
  })

  it('list / getById 透传 prisma', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    await svc.list({ workspaceId: 'w1' })
    expect(deps.prisma.schemaRecord.findMany).toHaveBeenCalled()
    await svc.getById('sr-1')
    expect(deps.prisma.schemaRecord.findUnique).toHaveBeenCalledWith({ where: { id: 'sr-1' } })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/schema-generator/service.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/modules/schema-generator/service.ts`：

```typescript
import type { PrismaClient, SchemaRecord } from '@prisma/client'
import type { EntityExtractorService } from '../../core/extract/entity-extractor.js'
import type { SchemaAdapterService } from '../../core/extract/adapters/schema-adapter.js'
import type { JsonLdDocument, JsonLdBuilderService, LlmsTxtBuilderService, SchemaValidatorService, SupportedSchemaType } from './index.js'
import type { AutoSectionsService } from './auto-sections.js'
import type { AutoSectionsResult, LlmsTxtInput } from './types.js'
import type { SchemaRegistryService } from './schema-registry.js'

export interface SchemaService {
  generateJsonLd(input: {
    workspaceId: string
    pageUrl: string
    schemaType: SupportedSchemaType
    fields: Record<string, unknown>
  }): Promise<{ jsonld: JsonLdDocument; record: SchemaRecord }>

  generateLlmsTxt(input: {
    workspaceId: string
    pageUrl?: string
    brandName: string
    tagline: string
    sections: LlmsTxtInput['sections']
    updateFrequency?: LlmsTxtInput['updateFrequency']
  }): Promise<{ markdown: string; record: SchemaRecord }>

  regenerateForPage(pageId: string): Promise<SchemaRecord[]>

  list(input: { workspaceId: string; pageUrl?: string; schemaType?: string }): Promise<SchemaRecord[]>
  getById(id: string): Promise<SchemaRecord | null>

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
}): SchemaService {
  async function getNextVersion(workspaceId: string, pageUrl: string): Promise<number> {
    const latest = await deps.prisma.schemaRecord.findFirst({
      where: { workspaceId, pageUrl },
      orderBy: { version: 'desc' },
    })
    return (latest?.version ?? 0) + 1
  }

  return {
    async generateJsonLd(input) {
      const jsonld = deps.jsonLdBuilder.build({ type: input.schemaType, fields: input.fields })
      const validation = deps.validator.validate(jsonld)
      if (!validation.valid) {
        throw new Error(`Schema validation failed: ${validation.errors.map((e) => e.message).join('; ')}`)
      }

      const version = await getNextVersion(input.workspaceId, input.pageUrl)
      const record = await deps.prisma.schemaRecord.create({
        data: {
          workspaceId: input.workspaceId,
          pageUrl: input.pageUrl,
          schemaType: input.schemaType,
          content: jsonld as any,
          version,
        },
      })
      return { jsonld, record }
    },

    async generateLlmsTxt(input) {
      const markdown = deps.llmsTxtBuilder.build({
        brandName: input.brandName,
        tagline: input.tagline,
        sections: input.sections,
        updateFrequency: input.updateFrequency,
      })
      const pageUrl = input.pageUrl ?? '/llms.txt'
      const version = await getNextVersion(input.workspaceId, pageUrl)
      const record = await deps.prisma.schemaRecord.create({
        data: {
          workspaceId: input.workspaceId,
          pageUrl,
          schemaType: 'LlmsTxt',
          content: { markdown } as any,
          llmsTxtSection: 'all',
          version,
        },
      })
      return { markdown, record }
    },

    async regenerateForPage(pageId) {
      const page = await deps.prisma.contentPage.findUnique({ where: { id: pageId } })
      if (!page) return []

      const extraction = await deps.extractor.extract(page.currentContent)
      const schemaEntities = deps.schemaAdapter.adapt(extraction.entities)

      const records: SchemaRecord[] = []
      for (const entity of schemaEntities) {
        try {
          const jsonld = deps.jsonLdBuilder.build({ type: entity.type, fields: entity.fields })
          const validation = deps.validator.validate(jsonld)
          if (!validation.valid) continue

          const version = await getNextVersion(page.workspaceId, page.url)
          const record = await deps.prisma.schemaRecord.create({
            data: {
              workspaceId: page.workspaceId,
              pageUrl: page.url,
              schemaType: entity.type,
              content: jsonld as any,
              version,
            },
          })
          records.push(record)
        } catch {
          // 跳过校验/构建失败的实体
        }
      }
      return records
    },

    async list(input) {
      const where: any = { workspaceId: input.workspaceId }
      if (input.pageUrl) where.pageUrl = input.pageUrl
      if (input.schemaType) where.schemaType = input.schemaType
      return deps.prisma.schemaRecord.findMany({ where, orderBy: { createdAt: 'desc' } })
    },

    async getById(id) {
      return deps.prisma.schemaRecord.findUnique({ where: { id } })
    },

    async buildAutoSections(workspaceId) {
      return deps.autoSections.buildSections(workspaceId)
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/schema-generator/service.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/schema-generator/service.ts src/modules/schema-generator/service.test.ts
git commit -m "feat(schema-generator): add SchemaService with generation, regeneration and CRUD"
```

---

## 任务 14：KgExtractor（抽取 → 适配 → 创建 PENDING 任务）

**文件：**
- 创建：`src/modules/knowledge-graph/extractor.ts`
- 测试：`src/modules/knowledge-graph/extractor.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/knowledge-graph/extractor.test.ts`：

```typescript
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/knowledge-graph/extractor.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/modules/knowledge-graph/extractor.ts`：

```typescript
import type { PrismaClient, OptimizationTask } from '@prisma/client'
import type { EntityExtractorService } from '../../core/extract/entity-extractor.js'
import type { KgAdapterService } from '../../core/extract/adapters/kg-adapter.js'
import type { KgProposalSet } from './types.js'

export interface KgExtractorService {
  extractFromPage(pageId: string): Promise<{ proposals: KgProposalSet; task: OptimizationTask }>
}

export function createKgExtractor(deps: {
  prisma: PrismaClient
  extractor: EntityExtractorService
  kgAdapter: KgAdapterService
}): KgExtractorService {
  return {
    async extractFromPage(pageId) {
      const page = await deps.prisma.contentPage.findUnique({ where: { id: pageId } })
      if (!page) throw new Error(`Page not found: ${pageId}`)

      const extraction = await deps.extractor.extract(page.currentContent)
      const entities = deps.kgAdapter.adapt(extraction.entities)

      const proposals: KgProposalSet = {
        entities,
        relations: extraction.relations.map((r) => ({
          fromName: r.fromName,
          toName: r.toName,
          relationType: r.relationType,
          properties: r.properties,
        })),
        sourcePageUrl: page.url,
        extractedAt: new Date().toISOString(),
      }

      const task = await deps.prisma.optimizationTask.create({
        data: {
          workspaceId: page.workspaceId,
          type: 'UPDATE_KG',
          status: 'PENDING',
          pageId,
          result: proposals as any,
          extractionProposals: proposals as any,
        },
      })

      return { proposals, task }
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/knowledge-graph/extractor.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/knowledge-graph/extractor.ts src/modules/knowledge-graph/extractor.test.ts
git commit -m "feat(knowledge-graph): add KgExtractor with page → task workflow"
```

---

## 任务 15：GraphExporter（JSON-LD / RDF Turtle 导出）

**文件：**
- 创建：`src/modules/knowledge-graph/exporter.ts`
- 测试：`src/modules/knowledge-graph/exporter.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/knowledge-graph/exporter.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createGraphExporter } from './exporter.js'
import type { PrismaClient } from '@prisma/client'

function mockPrisma(entities: any[] = [], relations: any[] = []) {
  return {
    kgEntity: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        const ws = where?.workspaceId
        if (!ws) return entities
        return entities.filter((e) => e.workspaceId === ws)
      }),
      findUnique: vi.fn().mockImplementation(async ({ where }: any) =>
        entities.find((e) => e.id === where.id),
      ),
    },
    kgRelation: {
      findMany: vi.fn().mockResolvedValue(relations),
    },
  } as unknown as PrismaClient
}

describe('GraphExporter', () => {
  it('export jsonld 输出 @context + @graph 结构', async () => {
    const exporter = createGraphExporter(
      mockPrisma(
        [
          { id: 'e1', workspaceId: 'w1', name: 'zoomer AI', type: 'SoftwareApplication', properties: { url: 'https://x.com' } },
        ],
        [],
      ),
    )
    const out = await exporter.export({ workspaceId: 'w1', format: 'jsonld' })
    const parsed = JSON.parse(out)
    expect(parsed['@context']).toBeDefined()
    expect(parsed['@graph']).toHaveLength(1)
    expect(parsed['@graph'][0]['@type']).toBe('SoftwareApplication')
    expect(parsed['@graph'][0]['@id']).toContain('zoomer-ai')
  })

  it('export turtle 输出 @prefix + 主语谓语宾语句子', async () => {
    const exporter = createGraphExporter(
      mockPrisma(
        [
          { id: 'e1', workspaceId: 'w1', name: 'zoomer AI', type: 'SoftwareApplication', properties: { name: 'zoomer AI', url: 'https://x.com' } },
        ],
        [],
      ),
    )
    const out = await exporter.export({ workspaceId: 'w1', format: 'turtle' })
    expect(out).toMatch(/^@prefix/)
    expect(out).toContain('a schema:SoftwareApplication')
    expect(out).toMatch(/schema:name\s+"zoomer AI"/)
  })

  it('空 workspace 时 jsonld 输出空 @graph', async () => {
    const exporter = createGraphExporter(mockPrisma([]))
    const out = await exporter.export({ workspaceId: 'empty', format: 'jsonld' })
    const parsed = JSON.parse(out)
    expect(parsed['@graph']).toEqual([])
  })

  it('空 workspace 时 turtle 仅输出 @prefix', async () => {
    const exporter = createGraphExporter(mockPrisma([]))
    const out = await exporter.export({ workspaceId: 'empty', format: 'turtle' })
    expect(out).toMatch(/^@prefix/)
  })

  it('entityIds 过滤生效', async () => {
    const exporter = createGraphExporter(
      mockPrisma([
        { id: 'e1', workspaceId: 'w1', name: 'A', type: 'X', properties: {} },
        { id: 'e2', workspaceId: 'w1', name: 'B', type: 'X', properties: {} },
      ]),
    )
    const out = await exporter.export({ workspaceId: 'w1', format: 'jsonld', entityIds: ['e1'] })
    const parsed = JSON.parse(out)
    expect(parsed['@graph']).toHaveLength(1)
    expect(parsed['@graph'][0]['@id']).toContain('a')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/knowledge-graph/exporter.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/modules/knowledge-graph/exporter.ts`：

```typescript
import type { PrismaClient, KgEntity, KgRelation } from '@prisma/client'
import type { ExportInput, ExportFormat } from './types.js'

const KG_VOCAB = 'https://your-domain.com/kg/'
const SCHEMA_VOCAB = 'https://schema.org/'

export interface GraphExporterService {
  export(input: ExportInput): Promise<string>
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
}

function escapeTtl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

export function createGraphExporter(prisma: PrismaClient): GraphExporterService {
  return {
    async export(input) {
      const where: any = { workspaceId: input.workspaceId }
      if (input.entityIds && input.entityIds.length > 0) {
        where.id = { in: input.entityIds }
      }
      const entities = await prisma.kgEntity.findMany({ where })
      const relations = await prisma.kgRelation.findMany({
        where: {
          OR: [
            { fromEntity: { workspaceId: input.workspaceId } },
            { toEntity: { workspaceId: input.workspaceId } },
          ],
        },
      })

      return input.format === 'jsonld' ? toJsonLd(entities, relations) : toTurtle(entities, relations)
    },
  }
}

function toJsonLd(entities: KgEntity[], relations: KgRelation[]): string {
  const entityIndex = new Map(entities.map((e) => [e.id, e]))
  const graph = entities.map((e) => {
    const props = (e.properties as Record<string, unknown>) ?? {}
    const node: Record<string, unknown> = {
      '@id': `kg:${slugify(e.name)}`,
      '@type': e.type,
      ...props,
    }
    return node
  })

  // 把 relations 附加到 from 节点的 kg:relationType 字段
  for (const rel of relations) {
    const from = entityIndex.get(rel.fromEntityId)
    const to = entityIndex.get(rel.toEntityId)
    if (!from || !to) continue
    const fromNode = graph.find((n) => (n as any)['@id'] === `kg:${slugify(from.name)}`)
    if (fromNode) {
      fromNode[`kg:${rel.relationType}`] = { '@id': `kg:${slugify(to.name)}` }
    }
  }

  return JSON.stringify({
    '@context': {
      '@vocab': SCHEMA_VOCAB,
      kg: KG_VOCAB,
    },
    '@graph': graph,
  }, null, 2)
}

function toTurtle(entities: KgEntity[], relations: KgRelation[]): string {
  const lines: string[] = []
  lines.push(`@prefix kg: <${KG_VOCAB}> .`)
  lines.push(`@prefix schema: <${SCHEMA_VOCAB}> .`)
  lines.push('')

  for (const e of entities) {
    const id = `kg:${slugify(e.name)}`
    lines.push(`${id} a schema:${e.type} ;`)
    const props = (e.properties as Record<string, unknown>) ?? {}
    const propKeys = Object.keys(props)
    propKeys.forEach((key, idx) => {
      const sep = idx === propKeys.length - 1 ? '.' : ';'
      const v = props[key]
      if (typeof v === 'string') {
        lines.push(`    schema:${key} "${escapeTtl(v)}"${sep}`)
      }
    })
    if (propKeys.length === 0) lines[lines.length - 1] = `${id} a schema:${e.type} .`
    lines.push('')
  }

  for (const rel of relations) {
    const fromEntity = entities.find((e) => e.id === rel.fromEntityId)
    const toEntity = entities.find((e) => e.id === rel.toEntityId)
    if (!fromEntity || !toEntity) continue
    lines.push(`kg:${slugify(fromEntity.name)} kg:${rel.relationType} kg:${slugify(toEntity.name)} .`)
  }

  return lines.join('\n').trim() + '\n'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/knowledge-graph/exporter.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/knowledge-graph/exporter.ts src/modules/knowledge-graph/exporter.test.ts
git commit -m "feat(knowledge-graph): add GraphExporter with JSON-LD and Turtle formats"
```

---

## 任务 16：KgService（编排）

**文件：**
- 创建：`src/modules/knowledge-graph/service.ts`
- 测试：`src/modules/knowledge-graph/service.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/knowledge-graph/service.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createKgService } from './service.js'
import type { PrismaClient, KgEntity, KgRelation } from '@prisma/client'
import type { KgRepositoryService } from './repository.js'
import type { KgExtractorService } from './extractor.js'
import type { GraphExporterService } from './exporter.js'
import type { KgProposalSet } from './types.js'

function mockDeps() {
  const prisma = {} as PrismaClient
  const repository: KgRepositoryService = {
    findEntityByName: vi.fn(),
    findEntityById: vi.fn(),
    findEntities: vi.fn(),
    addEntity: vi.fn().mockImplementation(async (input) => ({ id: 'new', ...input } as any)),
    removeEntity: vi.fn(),
    findRelations: vi.fn(),
    addRelation: vi.fn().mockImplementation(async (input) => ({ id: 'rel-1', ...input } as any)),
  }
  const extractor: KgExtractorService = {
    extractFromPage: vi.fn().mockResolvedValue({ proposals: {} as any, task: { id: 'task-1' } as any }),
  }
  const exporter: GraphExporterService = {
    export: vi.fn().mockResolvedValue('{"@graph":[]}'),
  }
  return { prisma, repository, extractor, exporter }
}

describe('KgService', () => {
  it('addEntity / addRelation 透传 repository', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    const entity = await svc.addEntity({ workspaceId: 'w1', name: 'X', type: 'Y', properties: {} })
    expect(deps.repository.addEntity).toHaveBeenCalled()
    expect(entity.id).toBe('new')
  })

  it('removeEntity 透传 repository', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.removeEntity('e1')
    expect(deps.repository.removeEntity).toHaveBeenCalledWith('e1')
  })

  it('extractFromPage 透传 extractor', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.extractFromPage('page-1')
    expect(deps.extractor.extractFromPage).toHaveBeenCalledWith('page-1')
  })

  it('persistProposals 跳过已存在实体，持久化新实体和两端完整的关系', async () => {
    const deps = mockDeps()
    ;(deps.repository.findEntityByName as any).mockImplementation(async (_ws: string, name: string) =>
      name === 'existing' ? { id: 'ex-1', name: 'existing' } : null,
    )
    const svc = createKgService(deps)
    const proposals: KgProposalSet = {
      entities: [
        { name: 'existing', type: 'X', properties: {} },
        { name: 'newOne', type: 'Y', properties: {} },
      ],
      relations: [
        { fromName: 'existing', toName: 'newOne', relationType: 'competitor' },
        { fromName: 'missingOne', toName: 'newOne', relationType: 'competitor' },
      ],
      sourcePageUrl: 'https://x.com',
      extractedAt: '2026-06-14T00:00:00Z',
    }
    const result = await svc.persistProposals('w1', proposals)
    expect(result.entitiesCreated).toBe(1)
    expect(result.entitiesSkipped).toBe(1)
    expect(result.relationsCreated).toBe(1)
    expect(result.relationsSkipped).toBe(1)
  })

  it('listEntities / listRelations / getEntity / exportGraph 透传', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.listEntities('w1')
    expect(deps.repository.findEntities).toHaveBeenCalled()
    await svc.exportGraph({ workspaceId: 'w1', format: 'jsonld' })
    expect(deps.exporter.export).toHaveBeenCalled()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/knowledge-graph/service.test.ts`
预期：FAIL。

- [ ] **步骤 3：编写实现**

创建 `src/modules/knowledge-graph/service.ts`：

```typescript
import type { PrismaClient, KgEntity, KgRelation, OptimizationTask } from '@prisma/client'
import type { KgRepositoryService } from './repository.js'
import type { KgExtractorService } from './extractor.js'
import type { GraphExporterService } from './exporter.js'
import type { KgProposalSet, ExportInput } from './types.js'

export interface KgService {
  // 手动 CRUD
  addEntity(input: { workspaceId: string; name: string; type: string; properties: Record<string, unknown>; sourceUrl?: string }): Promise<KgEntity>
  addRelation(input: { fromName: string; toName: string; relationType: string; properties?: Record<string, unknown> }): Promise<KgRelation>
  removeEntity(id: string): Promise<void>

  // 自动抽取
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
}): KgService {
  return {
    addEntity: (input) => deps.repository.addEntity(input),
    addRelation: (input) => deps.repository.addRelation(input),
    removeEntity: (id) => deps.repository.removeEntity(id),
    extractFromPage: (pageId) => deps.extractor.extractFromPage(pageId).then((r) => r.task),

    async persistProposals(workspaceId, proposals) {
      let entitiesCreated = 0
      let entitiesSkipped = 0

      // 1. 实体去重后入库
      for (const e of proposals.entities) {
        const existing = await deps.repository.findEntityByName(workspaceId, e.name)
        if (existing) {
          entitiesSkipped++
          continue
        }
        try {
          await deps.repository.addEntity({
            workspaceId,
            name: e.name,
            type: e.type,
            properties: e.properties,
            sourceUrl: e.sourceUrl ?? proposals.sourcePageUrl,
          })
          entitiesCreated++
        } catch {
          entitiesSkipped++
        }
      }

      // 2. 关系（两端实体都已存在才创建）
      let relationsCreated = 0
      let relationsSkipped = 0
      for (const r of proposals.relations) {
        const [from, to] = await Promise.all([
          deps.repository.findEntityByName(workspaceId, r.fromName),
          deps.repository.findEntityByName(workspaceId, r.toName),
        ])
        if (!from || !to) {
          relationsSkipped++
          continue
        }
        try {
          await deps.repository.addRelation({
            fromName: r.fromName,
            toName: r.toName,
            relationType: r.relationType,
            properties: r.properties,
          })
          relationsCreated++
        } catch {
          relationsSkipped++
        }
      }

      return { entitiesCreated, entitiesSkipped, relationsCreated, relationsSkipped }
    },

    listEntities: (workspaceId, opts) => deps.repository.findEntities(workspaceId, opts),
    listRelations: (opts) => deps.repository.findRelations(opts),
    getEntity: (id) => deps.repository.findEntityById(id),
    exportGraph: (input) => deps.exporter.export(input),
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/knowledge-graph/service.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/knowledge-graph/service.ts src/modules/knowledge-graph/service.test.ts
git commit -m "feat(knowledge-graph): add KgService with CRUD, extraction and proposal persistence"
```

---

## 任务 17：TaskService 扩展（onPublished 回调钩子）

**文件：**
- 修改：`src/modules/content-optimizer/task-service.ts`
- 修改：`src/modules/content-optimizer/task-service.test.ts`

- [ ] **步骤 1：在 task-service.test.ts 中追加新测试**

在 `src/modules/content-optimizer/task-service.test.ts` 文件末尾（在 `describe('OptimizationTaskService', () => { ... })` 内部最后一个 `it(...)` 之后）追加以下测试：

```typescript
  it('publish 触发 onPublished 回调，传入更新后的任务', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'REVIEWED',
      pageId: 'page-1',
      workspaceId: 'w1',
    })
    const onPublished = vi.fn()
    const svc = createTaskService({ prisma, onPublished })
    await svc.publish('task-1')
    expect(onPublished).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1', status: 'PUBLISHED' }),
    )
  })

  it('publish 未提供 onPublished 时正常更新状态', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'REVIEWED',
      pageId: 'page-1',
    })
    const svc = createTaskService({ prisma })
    const task = await svc.publish('task-1')
    expect(task.status).toBe('PUBLISHED')
  })

  it('publish 回调抛错被捕获，不影响状态更新（仅记录日志）', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'REVIEWED',
      pageId: 'page-1',
    })
    const onPublished = vi.fn().mockRejectedValue(new Error('回调失败'))
    const svc = createTaskService({ prisma, onPublished })
    const task = await svc.publish('task-1')
    expect(task.status).toBe('PUBLISHED')
    expect(onPublished).toHaveBeenCalled()
  })
```

同时需要修改文件开头的 import 行（顶部）以使用对象形式传参：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTaskService } from './task-service.js'
```

并把现有 `createTaskService(prisma)` 调用替换为 `createTaskService({ prisma })`，共 6 处：

- `it('create 创建任务'...)` 内
- `it('list 按 workspace 查询任务'...)` 内
- `it('list 按 workspace + status 过滤'...)` 内
- `it('getById 查询单个任务'...)` 内
- `it('review approve 时...'...)` 内
- `it('review reject 时...'...)` 内
- `it('publish 将 REVIEWED...'...)` 内
- `it('publish 非 REVIEWED...'...)` 内

每处都改为 `const svc = createTaskService({ prisma })`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/content-optimizer/task-service.test.ts`
预期：FAIL（onPublished 参数未支持）。

- [ ] **步骤 3：修改 task-service.ts**

将整个 `src/modules/content-optimizer/task-service.ts` 内容替换为：

```typescript
import type { PrismaClient, OptimizationTask, TaskType, TaskStatus } from '@prisma/client'

export interface CreateTaskInput {
  workspaceId: string
  type: TaskType
  pageId?: string
  queryId?: string
  beforeScore?: number
  afterScore?: number
  result?: Record<string, unknown>
}

export interface TaskServiceDeps {
  prisma: PrismaClient
  onPublished?: (task: OptimizationTask) => Promise<void>
}

export interface TaskService {
  create(input: CreateTaskInput): Promise<OptimizationTask>
  list(workspaceId: string, status?: TaskStatus): Promise<OptimizationTask[]>
  getById(id: string): Promise<OptimizationTask | null>
  review(id: string, approved: boolean, note?: string): Promise<OptimizationTask>
  publish(id: string): Promise<OptimizationTask>
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { prisma, onPublished } = deps

  return {
    async create(input) {
      return prisma.optimizationTask.create({
        data: {
          workspaceId: input.workspaceId,
          type: input.type,
          pageId: input.pageId,
          queryId: input.queryId,
          beforeScore: input.beforeScore,
          afterScore: input.afterScore,
          result: (input.result as any) ?? undefined,
          status: 'PENDING',
        },
      })
    },

    async list(workspaceId, status) {
      const where: any = { workspaceId }
      if (status) where.status = status
      return prisma.optimizationTask.findMany({ where })
    },

    async getById(id) {
      return prisma.optimizationTask.findUnique({ where: { id } })
    },

    async review(id, approved, note) {
      const task = await prisma.optimizationTask.findUnique({ where: { id } })
      if (!task) throw new Error(`Task not found: ${id}`)

      if (approved) {
        const updated = await prisma.optimizationTask.update({
          where: { id },
          data: { status: 'REVIEWED' },
        })
        if (task.pageId) {
          await prisma.contentPage.update({
            where: { id: task.pageId },
            data: { status: 'REVIEWED' },
          })
        }
        return updated
      }

      return prisma.optimizationTask.update({
        where: { id },
        data: { status: 'PENDING', reviewNote: note },
      })
    },

    async publish(id) {
      const task = await prisma.optimizationTask.findUnique({ where: { id } })
      if (!task) throw new Error(`Task not found: ${id}`)
      if (task.status !== 'REVIEWED') {
        throw new Error(`Task must be REVIEWED to publish, current: ${task.status}`)
      }

      const updated = await prisma.optimizationTask.update({
        where: { id },
        data: { status: 'PUBLISHED' },
      })
      if (task.pageId) {
        await prisma.contentPage.update({
          where: { id: task.pageId },
          data: { status: 'PUBLISHED' },
        })
      }

      // 触发回调（失败不影响状态更新）
      if (onPublished) {
        try {
          await onPublished(updated)
        } catch (err) {
          console.error(`[taskService] onPublished callback failed for task ${id}:`, err)
        }
      }

      return updated
    },
  }
}
```

- [ ] **步骤 4：同步修改 server.ts 和 router.ts 中的 taskService 调用**

在后续任务 19 中统一处理。这里先验证 task-service.test.ts 通过：

运行：`npx vitest run src/modules/content-optimizer/task-service.test.ts`
预期：PASS（8 个原有测试 + 3 个新增测试 = 11 个）。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/content-optimizer/task-service.ts src/modules/content-optimizer/task-service.test.ts
git commit -m "feat(task-service): add onPublished callback hook for phase 3 integration"
```

> **注意：** 此 commit 后，server.ts 中 `createTaskService(prisma)` 调用会编译失败。任务 19（server.ts 装配）会修复这一点。

---

## 任务 18：schemaRouter 和 kgRouter

**文件：**
- 创建：`src/modules/schema-generator/router.ts`
- 创建：`src/modules/schema-generator/router.test.ts`
- 创建：`src/modules/knowledge-graph/router.ts`
- 创建：`src/modules/knowledge-graph/router.test.ts`

- [ ] **步骤 1：编写 schemaRouter 测试**

创建 `src/modules/schema-generator/router.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { schemaRouter } from './router.js'

function mockCtx(services: any, workspaceId = 'w1') {
  return { ctx: { workspace: { id: workspaceId }, services } } as any
}

describe('schemaRouter', () => {
  const schema = {
    generateJsonLd: vi.fn().mockResolvedValue({ jsonld: { '@type': 'X' }, record: { id: 'sr-1' } }),
    generateLlmsTxt: vi.fn().mockResolvedValue({ markdown: '# x', record: { id: 'sr-2' } }),
    regenerateForPage: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    buildAutoSections: vi.fn().mockResolvedValue({ sections: [], warnings: [] }),
  }
  const services = { schema }

  it('generate.jsonLd 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    const input = { pageUrl: 'https://x.com', schemaType: 'SoftwareApplication' as const, fields: { name: 'a', applicationCategory: 'b' } }
    const result = await caller.generate.jsonLd(input)
    expect(schema.generateJsonLd).toHaveBeenCalledWith({ workspaceId: 'w1', ...input })
    expect(result.jsonld['@type']).toBe('SoftwareApplication')
  })

  it('generate.llmsTxt 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    const input = { brandName: 'z', tagline: 't', sections: [{ title: 'S', items: [] }] }
    const result = await caller.generate.llmsTxt(input)
    expect(schema.generateLlmsTxt).toHaveBeenCalled()
    expect(result.markdown).toBe('# x')
  })

  it('autoSections 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    await caller.autoSections()
    expect(schema.buildAutoSections).toHaveBeenCalledWith('w1')
  })

  it('list 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    await caller.list({ pageUrl: 'https://x.com' })
    expect(schema.list).toHaveBeenCalledWith({ workspaceId: 'w1', pageUrl: 'https://x.com' })
  })

  it('get 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    await caller.get({ id: 'sr-1' })
    expect(schema.getById).toHaveBeenCalledWith('sr-1')
  })

  it('regenerateForPage 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    await caller.regenerateForPage({ pageId: 'page-1' })
    expect(schema.regenerateForPage).toHaveBeenCalledWith('page-1')
  })
})
```

- [ ] **步骤 2：编写 kgRouter 测试**

创建 `src/modules/knowledge-graph/router.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { kgRouter } from './router.js'

function mockCtx(services: any, workspaceId = 'w1') {
  return { ctx: { workspace: { id: workspaceId }, services } } as any
}

describe('kgRouter', () => {
  const kg = {
    addEntity: vi.fn().mockResolvedValue({ id: 'e1' }),
    addRelation: vi.fn().mockResolvedValue({ id: 'r1' }),
    removeEntity: vi.fn().mockResolvedValue(undefined),
    listEntities: vi.fn().mockResolvedValue([]),
    listRelations: vi.fn().mockResolvedValue([]),
    getEntity: vi.fn().mockResolvedValue(null),
    extractFromPage: vi.fn().mockResolvedValue({ id: 'task-1' }),
    exportGraph: vi.fn().mockResolvedValue('{}'),
  }
  const services = { kg }

  it('addEntity 路由注入 workspaceId', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.addEntity({ name: 'X', type: 'Y', properties: {} })
    expect(kg.addEntity).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', name: 'X' }))
  })

  it('addRelation 路由', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.addRelation({ fromName: 'A', toName: 'B', relationType: 'competitor' })
    expect(kg.addRelation).toHaveBeenCalledWith({ fromName: 'A', toName: 'B', relationType: 'competitor' })
  })

  it('removeEntity 路由', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.removeEntity({ id: 'e1' })
    expect(kg.removeEntity).toHaveBeenCalledWith('e1')
  })

  it('listEntities 路由注入 workspaceId', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.listEntities({ type: 'SoftwareApplication' })
    expect(kg.listEntities).toHaveBeenCalledWith('w1', { type: 'SoftwareApplication' })
  })

  it('listRelations 路由', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.listRelations({ fromId: 'e1' })
    expect(kg.listRelations).toHaveBeenCalledWith({ fromId: 'e1' })
  })

  it('getEntity 路由', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.getEntity({ id: 'e1' })
    expect(kg.getEntity).toHaveBeenCalledWith('e1')
  })

  it('extractFromPage 路由', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.extractFromPage({ pageId: 'page-1' })
    expect(kg.extractFromPage).toHaveBeenCalledWith('page-1')
  })

  it('export 路由', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.export({ format: 'jsonld' })
    expect(kg.exportGraph).toHaveBeenCalledWith({ workspaceId: 'w1', format: 'jsonld', entityIds: undefined })
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：
```bash
npx vitest run src/modules/schema-generator/router.test.ts src/modules/knowledge-graph/router.test.ts
```
预期：FAIL（router 模块不存在）。

- [ ] **步骤 4：编写 schemaRouter**

创建 `src/modules/schema-generator/router.ts`：

```typescript
import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

const SUPPORTED_SCHEMA_TYPES = [
  'SoftwareApplication',
  'Organization',
  'Product',
  'FAQPage',
  'Article',
  'BreadcrumbList',
] as const

export const schemaRouter = router({
  generate: router({
    jsonLd: protectedProcedure
      .input(z.object({
        pageUrl: z.string(),
        schemaType: z.enum(SUPPORTED_SCHEMA_TYPES),
        fields: z.record(z.unknown()),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.schema.generateJsonLd({
          workspaceId: ctx.workspace.id,
          ...input,
        })
      }),

    llmsTxt: protectedProcedure
      .input(z.object({
        pageUrl: z.string().optional(),
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
          workspaceId: ctx.workspace.id,
          ...input,
        })
      }),
  }),

  autoSections: protectedProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      return ctx.services.schema.buildAutoSections(ctx.workspace.id)
    }),

  list: protectedProcedure
    .input(z.object({
      pageUrl: z.string().optional(),
      schemaType: z.string().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.schema.list({
        workspaceId: ctx.workspace.id,
        pageUrl: input?.pageUrl,
        schemaType: input?.schemaType,
      })
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.services.schema.getById(input.id)
    }),

  regenerateForPage: protectedProcedure
    .input(z.object({ pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.schema.regenerateForPage(input.pageId)
    }),
})
```

- [ ] **步骤 5：编写 kgRouter**

创建 `src/modules/knowledge-graph/router.ts`：

```typescript
import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

export const kgRouter = router({
  addEntity: protectedProcedure
    .input(z.object({
      name: z.string(),
      type: z.string(),
      properties: z.record(z.unknown()).default({}),
      sourceUrl: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.addEntity({
        workspaceId: ctx.workspace.id,
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

  listEntities: protectedProcedure
    .input(z.object({ type: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.listEntities(ctx.workspace.id, { type: input?.type })
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

  extractFromPage: protectedProcedure
    .input(z.object({ pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.extractFromPage(input.pageId)
    }),

  export: protectedProcedure
    .input(z.object({
      format: z.enum(['jsonld', 'turtle']),
      entityIds: z.array(z.string()).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.exportGraph({
        workspaceId: ctx.workspace.id,
        format: input.format,
        entityIds: input.entityIds,
      })
    }),
})
```

- [ ] **步骤 6：运行测试验证通过**

运行：
```bash
npx vitest run src/modules/schema-generator/router.test.ts src/modules/knowledge-graph/router.test.ts
```
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/modules/schema-generator/router.ts src/modules/schema-generator/router.test.ts \
        src/modules/knowledge-graph/router.ts src/modules/knowledge-graph/router.test.ts
git commit -m "feat(phase3): add schema and kg tRPC routers"
```

---

## 任务 19：server.ts 和 router.ts 装配

**文件：**
- 修改：`src/router.ts`
- 修改：`src/server.ts`

- [ ] **步骤 1：在 router.ts 注册新路由**

编辑 `src/router.ts`，在文件末尾 `tasks: taskRouter,` 之后追加：

```typescript
import { schemaRouter } from './modules/schema-generator/router.js'
import { kgRouter } from './modules/knowledge-graph/router.js'
```

并修改 `appRouter`：

```typescript
export const appRouter = router({
  workspace: workspaceRouter,
  citation: citationRouter,
  content: contentRouter,
  tasks: taskRouter,
  schema: schemaRouter,
  kg: kgRouter,
})
```

完整文件：

```typescript
import { router } from './core/trpc/init.js'
import { workspaceRouter } from './core/workspace/router.js'
import { citationRouter } from './modules/citation-monitor/router.js'
import { contentRouter } from './modules/content-optimizer/router.js'
import { taskRouter } from './modules/content-optimizer/task-router.js'
import { schemaRouter } from './modules/schema-generator/router.js'
import { kgRouter } from './modules/knowledge-graph/router.js'

export const appRouter = router({
  workspace: workspaceRouter,
  citation: citationRouter,
  content: contentRouter,
  tasks: taskRouter,
  schema: schemaRouter,
  kg: kgRouter,
})

export type AppRouter = typeof appRouter
```

- [ ] **步骤 2：在 server.ts 中装配新服务 + 注册回调**

修改 `src/server.ts`。先修改 import 行（顶部），在现有 content-optimizer imports 之后追加：

```typescript
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
```

然后修改 `main()` 中 taskService 创建那一行：

找到 `const taskService = createTaskService(prisma)`，替换为：

```typescript
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
```

最后修改 `services` 注入：

```typescript
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
```

- [ ] **步骤 3：验证编译**

运行：`npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 4：Commit**

```bash
git add src/router.ts src/server.ts
git commit -m "feat(phase3): wire schema and kg services into server with onPublished hook"
```

---

## 任务 20：完整测试验证

- [ ] **步骤 1：运行阶段 3 所有测试**

运行：`npx vitest run src/core/extract src/modules/schema-generator src/modules/knowledge-graph src/modules/content-optimizer/task-service.test.ts`
预期：全部 PASS。新增约 16 个测试文件，全部通过。

- [ ] **步骤 2：运行项目所有测试**

运行：`npx vitest run`
预期：阶段 1（43 个）+ 阶段 2（约 48 个）+ 阶段 3（约 30+ 个）= 总计 **120+ 个测试全部通过**。

- [ ] **步骤 3：类型检查**

运行：`npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 4：最终 Commit（如有遗漏）**

如果步骤 1-3 中有任何 fix commit 到此处：

```bash
git status
# 如果有未提交内容
git add -A
git commit -m "chore(phase3): final cleanup and verification"
```

---

## 自检（writing-plans 收尾清单）

### 1. 规格覆盖度

| 规格章节 | 覆盖任务 |
|----------|---------|
| 5.3 Schema Generator 架构 | 任务 4-7, 12-13, 18 |
| 5.3 JSON-LD 生成 | 任务 5（JsonLdBuilder）、13（SchemaService.generateJsonLd） |
| 5.3 llms.txt 生成 | 任务 6（LlmsTxtBuilder）、13（SchemaService.generateLlmsTxt） |
| 5.3 schema.org 校验 | 任务 7（SchemaValidator） |
| 5.4 Knowledge Graph 实体/关系 CRUD | 任务 11（KgRepository）、16（KgService）、18（kgRouter） |
| 5.4 RDF / JSON-LD 导出 | 任务 15（GraphExporter） |
| 5.4 实体抽取 | 任务 10（EntityExtractor）、8-9（适配器） |
| 4.3 SDK Schema 接口 | 任务 18（schemaRouter） |
| 4.3 SDK KG 接口 | 任务 18（kgRouter） |
| 任务联动（OptimizationTask 发布回调） | 任务 17（TaskService 钩子）、19（server.ts 装配） |
| KG 自动抽取走审核 | 任务 14（KgExtractor → OptimizationTask.UPDATE_KG） |
| Prisma 模型变更（spec 3.2） | 任务 1 |
| 双适配器架构 | 任务 8-9 |
| 范围边界（不含 webhook/RelationBuilder/SPARQL/Wikidata） | 不在本计划中（spec 第十章明确排除） |

### 2. 占位符扫描

- 无 TODO / TBD / "后续实现" 在任何任务步骤中
- 所有代码块都是完整可运行的（不是骨架）
- 所有测试都列出了预期输出
- 所有命令（运行测试、commit）都明确

### 3. 类型一致性

| 引用点 | 一致性 |
|--------|--------|
| `KgProposalSet` | 任务 3（types.ts）→ 14（KgExtractor 输出）→ 16（KgService.persistProposals 输入）→ 17-19（onPublished 回调读取） |
| `JsonLdDocument` / `SupportedSchemaType` | 任务 3（types.ts）→ 5（JsonLdBuilder）→ 7（Validator）→ 13（Service）→ 18（Router） |
| `SchemaService` / `KgService` 接口 | 任务 13 / 16 → 18（Router 引用 services.schema / services.kg）→ 19（services 注入） |
| `onPublished` 钩子签名 | 任务 17（TaskServiceDeps）→ 19（server.ts 装配） |
| `extractionProposals` 字段 | 任务 1（Prisma）→ 14（KgExtractor 写入）→ 19（server.ts 读取） |
| 6 种白名单类型 | 任务 4（Registry）→ 5（Builder 引用）→ 7（Validator 引用）→ 8（Adapter 关键词）→ 18（Router z.enum） |
| `createTaskService({ prisma })` 对象形式 | 任务 17（修改实现）→ 19（server.ts 使用）|

### 4. 风险提示（执行阶段需注意）

1. **任务 17 的中间状态**：提交后阶段 2 的 server.ts（`createTaskService(prisma)`）会编译失败。任务 19 必须紧接着完成。推荐执行时 17 和 19 视为一个原子提交组，或临时回退。
2. **Prisma 生成依赖**：任务 1 步骤 5 的 `npx prisma generate` 必须成功，否则任务 11 / 13 / 14 / 16 的 `import { KgEntity, KgRelation, SchemaRecord, OptimizationTask } from '@prisma/client'` 会编译失败。
3. **测试 mock Prisma 模型**：`KgEntity` / `KgRelation` / `SchemaRecord` 是 Prisma 生成的类型，测试代码中需要正确 mock 这些 model 字段（已在各测试中提供 mockPrisma helper）。
4. **server.ts 启动需要真实 DB**：本计划不涉及 e2e 测试或启动验证（沿用阶段 1/2 的策略）。所有 tRPC 路由调用 mock services 后单元测试通过即可。
5. **LlmsTxtBuilder.parseMarkdown**：测试覆盖了正向和反向解析，但对极端 markdown 输入（如多个 `## 更新频率` section）行为未严格定义，留待后续补强。