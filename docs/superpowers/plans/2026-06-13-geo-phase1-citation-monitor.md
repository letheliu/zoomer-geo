# GEO 系统 阶段 1：基础设施 + Citation Monitor 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 搭建独立的 geo-service 骨架并跑通 Citation Monitor（引用监测）闭环，产出第一份 baseline 数据。

**架构：** 单体 Node 服务（Fastify + tRPC + Prisma + PostgreSQL/pgvector + pg-boss），多租户 workspace 隔离，5 个 AI 平台可插拔适配器，定时监测任务，SDK 同仓发包。本计划只覆盖阶段 1 范围：core 共享层 + Citation Monitor 模块。

**技术栈：** TypeScript / Node.js、Fastify 4、tRPC 10、Prisma 5、PostgreSQL + pgvector、pg-boss、Vitest、pnpm workspaces。

**规格依据：** `docs/superpowers/specs/2026-06-13-geo-system-design.md`

**范围边界（本计划不包含）：** Content Optimizer、Schema Generator、Knowledge Graph、完整闭环优化——这些属于阶段 2/3/4，各自独立计划。

---

## 文件结构

以下列出本计划将创建的所有文件及其单一职责。按职责拆分，一起变更的文件放在一起。

```
geo-service/
├── package.json                          # 服务依赖与脚本
├── tsconfig.json                         # TS 配置（含 sdk 路径映射）
├── tsconfig.build.json                   # 构建用配置（排除测试）
├── vitest.config.ts                      # 测试配置
├── docker-compose.yml                    # PostgreSQL+pgvector 本地服务
├── .env.example                          # 环境变量模板
├── .gitignore
├── pnpm-workspace.yaml                   # 声明 sdk 子包
├── prisma/
│   └── schema.prisma                     # 数据模型（阶段 1 表）
├── prisma/sql/
│   └── 0001_pgvector.sql                 # pgvector 扩展与索引
├── src/
│   ├── core/
│   │   ├── db/client.ts                  # Prisma 单例客户端
│   │   ├── queue/boss.ts                 # pg-boss 实例工厂
│   │   ├── llm/types.ts                  # LLM 抽象接口与类型
│   │   ├── llm/openai-provider.ts        # OpenAI provider（chat + embed）
│   │   ├── llm/index.ts                  # LLM 客户端工厂
│   │   ├── workspace/service.ts          # workspace CRUD + API Key
│   │   ├── workspace/auth.ts             # API Key 校验逻辑
│   │   ├── trpc/context.ts               # tRPC 上下文（解析 workspace）
│   │   ├── trpc/init.ts                  # tRPC 初始化
│   │   └── workspace/router.ts           # workspace tRPC 路由
│   ├── modules/citation-monitor/
│   │   ├── platform-adapters/types.ts    # PlatformAdapter 接口与结果类型
│   │   ├── platform-adapters/registry.ts # adapter 注册表
│   │   ├── platform-adapters/openai.ts   # OpenAI 适配器
│   │   ├── platform-adapters/perplexity.ts
│   │   ├── platform-adapters/anthropic.ts
│   │   ├── platform-adapters/gemini.ts
│   │   ├── platform-adapters/deepseek.ts
│   │   ├── analyzer.ts                   # 引用分析（提及/排名/SOV）
│   │   ├── query-library.ts              # query 库管理
│   │   ├── monitor.ts                    # 监测调度编排
│   │   └── router.ts                     # citation tRPC 路由
│   ├── workers/
│   │   └── citation-scheduler.ts         # pg-boss 定时监测任务
│   ├── router.ts                         # tRPC 总路由
│   └── server.ts                         # Fastify 启动入口
├── sdk/
│   ├── package.json                      # @scope/geo-sdk
│   ├── tsconfig.json
│   └── src/
│       ├── client.ts                     # createGeoClient()
│       ├── types.ts                      # 从服务端 AppRouter 推导
│       └── index.ts
└── tests/
    └── （各单元测试与源码同目录 *.test.ts）
```

---

## 约定

- **包管理器：** pnpm（monorepo via workspaces）
- **测试框架：** Vitest
- **外部 HTTP 调用测试：** mock 全局 `fetch`
- **数据库测试：** mock PrismaClient（单元层不依赖真实 DB）
- **提交粒度：** 每个任务结束 commit 一次，使用 Conventional Commits

---

## 任务 1：项目脚手架

**文件：**
- 创建：`package.json`、`tsconfig.json`、`tsconfig.build.json`、`vitest.config.ts`、`docker-compose.yml`、`.env.example`、`.gitignore`、`pnpm-workspace.yaml`

- [ ] **步骤 1：创建 `package.json`**

```json
{
  "name": "geo-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:push": "prisma db push",
    "db:seed": "tsx prisma/seed.ts"
  },
  "dependencies": {
    "@prisma/client": "^5.18.0",
    "@trpc/server": "^10.45.0",
    "fastify": "^4.28.0",
    "@trpc/server/adapters/fastify": "^10.45.0",
    "pg-boss": "^10.1.0",
    "zod": "^3.23.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.16.0",
    "vitest": "^2.0.0",
    "prisma": "^5.18.0",
    "@types/node": "^20.14.0"
  }
}
```

- [ ] **步骤 2：创建 `pnpm-workspace.yaml`**

```yaml
packages:
  - "sdk"
```

- [ ] **步骤 3：创建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "baseUrl": ".",
    "paths": {
      "@geo-service/*": ["src/*"],
      "@scope/geo-sdk": ["sdk/src/index.ts"]
    }
  },
  "include": ["src", "sdk", "tests"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **步骤 4：创建 `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "tests", "**/*.test.ts", "sdk"]
}
```

- [ ] **步骤 5：创建 `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@geo-service': new URL('./src', import.meta.url).pathname,
    },
  },
})
```

- [ ] **步骤 6：创建 `docker-compose.yml`**

```yaml
version: '3.9'
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: geo-postgres
    environment:
      POSTGRES_USER: geo
      POSTGRES_PASSWORD: geo_secret
      POSTGRES_DB: geo
    ports:
      - '5432:5432'
    volumes:
      - geo_pgdata:/var/lib/postgresql/data
volumes:
  geo_pgdata:
```

- [ ] **步骤 7：创建 `.env.example`**

```bash
# 数据库
DATABASE_URL="postgresql://geo:geo_secret@localhost:5432/geo?schema=public"

# 服务
PORT=3000

# LLM（内部任务用，如 query 生成）
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
CHAT_MODEL=gpt-4o-mini

# 监测目标平台凭证（示例，实际存于 workspace.platformConfig）
# 各 adapter 运行时从 workspace 读取
```

- [ ] **步骤 8：创建 `.gitignore`**

```gitignore
node_modules/
dist/
.env
*.log
pnpm-lock.yaml
prisma/migrations/dev.db*
```

- [ ] **步骤 9：安装依赖并验证脚手架可用**

运行：`pnpm install`
预期：安装成功，无错误。

运行：`pnpm test`
预期：`No test files found`（正常，尚未写测试）。

- [ ] **步骤 10：Commit**

```bash
git add -A
git commit -m "chore: scaffold geo-service project structure"
```

---

## 任务 2：Prisma Schema + 数据库客户端

**文件：**
- 创建：`prisma/schema.prisma`、`prisma/sql/0001_pgvector.sql`、`src/core/db/client.ts`
- 测试：`src/core/db/client.test.ts`

- [ ] **步骤 1：创建 `prisma/schema.prisma`（阶段 1 模型）**

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}

// ============ 基础：多租户 ============

model Workspace {
  id                String          @id @default(cuid())
  name              String
  domain            String?
  llmsTxtUrl        String?
  defaultBrandName  String
  apiKeyHash        String
  platformConfig    Json            @default("{}")
  status            WorkspaceStatus @default(ACTIVE)
  createdAt         DateTime        @default(now())
  updatedAt         DateTime        @updatedAt

  queries           CitationQuery[]
  events            CitationEvent[]

  @@index([status])
}

enum WorkspaceStatus {
  ACTIVE
  SUSPENDED
}

// ============ 模块 1：引用监测 ============

model CitationQuery {
  id          String      @id @default(cuid())
  workspaceId String
  workspace   Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  queryText   String
  intent      Json        @default("{}")
  source      QuerySource
  status      QueryStatus @default(ACTIVE)
  embedding   Unsupported("vector(1536)")?
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  events      CitationEvent[]

  @@index([workspaceId, status])
}

enum QuerySource {
  GOOGLE_SUGGEST
  LLM_GENERATED
  PAA
  MANUAL
  COMPETITOR
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
  platform      String
  brandMentioned Boolean
  rankInAnswer  Int?
  citedUrls     Json     @default("[]")
  competitors   Json     @default("[]")
  rawAnswer     String   @db.Text
  sovScore      Float?
  embedding     Unsupported("vector(1536)")?
  capturedAt    DateTime @default(now())

  @@index([workspaceId, platform, capturedAt])
  @@index([queryId, capturedAt])
}
```

- [ ] **步骤 2：创建 `prisma/sql/0001_pgvector.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE INDEX IF NOT EXISTS idx_citation_query_embedding
  ON "CitationQuery" USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_citation_event_embedding
  ON "CitationEvent" USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

- [ ] **步骤 3：编写失败的测试 `src/core/db/client.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { getPrismaClient, resetPrismaClient } from './client.js'

describe('db client', () => {
  it('返回单例 PrismaClient 实例', () => {
    const a = getPrismaClient()
    const b = getPrismaClient()
    expect(a).toBe(b)
  })

  it('reset 后返回新实例', () => {
    const before = getPrismaClient()
    resetPrismaClient()
    const after = getPrismaClient()
    expect(after).not.toBe(before)
  })
})
```

- [ ] **步骤 4：运行测试验证失败**

运行：`pnpm test src/core/db/client.test.ts`
预期：FAIL，报错模块找不到 `./client.js`。

- [ ] **步骤 5：编写实现 `src/core/db/client.ts`**

```typescript
import { PrismaClient } from '@prisma/client'

let client: PrismaClient | null = null

export function getPrismaClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient()
  }
  return client
}

export function resetPrismaClient(): void {
  client = null
}
```

- [ ] **步骤 6：生成 Prisma 客户端并运行测试**

运行：`pnpm db:generate`
预期：成功生成 `@prisma/client`。

运行：`pnpm test src/core/db/client.test.ts`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add prisma src/core/db
git commit -m "feat(db): add prisma schema for workspace/citation models"
```

---

## 任务 3：pg-boss 任务队列

**文件：**
- 创建：`src/core/queue/boss.ts`
- 测试：`src/core/queue/boss.test.ts`

- [ ] **步骤 1：编写失败的测试 `src/core/queue/boss.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockStart = vi.fn().mockResolvedValue(undefined)
const mockSchedule = vi.fn().mockResolvedValue(undefined)

vi.mock('pg-boss', () => {
  return {
    default: class MockPgBoss {
      start = mockStart
      schedule = mockSchedule
    },
  }
})

describe('pg-boss queue', () => {
  beforeEach(() => {
    mockStart.mockClear()
    mockSchedule.mockClear()
  })

  it('创建实例并启动', async () => {
    const { createQueue } = await import('./boss.js')
    const boss = await createQueue()
    expect(mockStart).toHaveBeenCalled()
    expect(boss).toBeDefined()
  })

  it('注册定时任务', async () => {
    const { createQueue } = await import('./boss.js')
    const boss = await createQueue()
    await boss.schedule('citation-monitor-daily', { workspaceId: 'w1' })
    expect(mockSchedule).toHaveBeenCalledWith('citation-monitor-daily', { workspaceId: 'w1' })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/core/queue/boss.test.ts`
预期：FAIL，找不到 `./boss.js`。

- [ ] **步骤 3：编写实现 `src/core/queue/boss.ts`**

```typescript
import PgBoss from 'pg-boss'

export type Queue = PgBoss

export async function createQueue(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL! })
  await boss.start()
  return boss
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/core/queue/boss.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/core/queue
git commit -m "feat(queue): add pg-boss queue factory"
```

---

## 任务 4：LLM 客户端抽象层

**文件：**
- 创建：`src/core/llm/types.ts`、`src/core/llm/openai-provider.ts`、`src/core/llm/index.ts`
- 测试：`src/core/llm/openai-provider.test.ts`

- [ ] **步骤 1：创建类型定义 `src/core/llm/types.ts`**

```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface ChatResponse {
  text: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface LlmProvider {
  name: string
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>
  embed(text: string): Promise<number[]>
}
```

- [ ] **步骤 2：编写失败的测试 `src/core/llm/openai-provider.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAiProvider } from './openai-provider.js'

describe('OpenAiProvider', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('chat 调用 chat completions 并返回文本', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Hello GEO' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAiProvider()
    const res = await provider.chat([{ role: 'user', content: 'hi' }])

    expect(res.text).toBe('Hello GEO')
    expect(res.usage?.completionTokens).toBe(3)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.messages[0].content).toBe('hi')
  })

  it('embed 调用 embeddings 并返回向量数组', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ embedding: Array(1536).fill(0.1) }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAiProvider()
    const vec = await provider.embed('some text')
    expect(vec).toHaveLength(1536)
  })

  it('chat 失败时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{"error":"bad"}', { status: 500 }),
    ))
    const provider = new OpenAiProvider()
    await expect(provider.chat([{ role: 'user', content: 'x' }])).rejects.toThrow()
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`pnpm test src/core/llm/openai-provider.test.ts`
预期：FAIL，找不到 `./openai-provider.js`。

- [ ] **步骤 4：编写实现 `src/core/llm/openai-provider.ts`**

```typescript
import type { ChatMessage, ChatOptions, ChatResponse, LlmProvider } from './types.js'

export class OpenAiProvider implements LlmProvider {
  name = 'openai'
  private apiKey = process.env.OPENAI_API_KEY!
  private baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  private chatModel = process.env.CHAT_MODEL || 'gpt-4o-mini'
  private embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small'

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || this.chatModel,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens,
        messages,
      }),
    })
    if (!res.ok) {
      throw new Error(`OpenAI chat failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    return {
      text: json.choices[0].message.content,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      },
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.embeddingModel, input: text }),
    })
    if (!res.ok) {
      throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] }
    return json.data[0].embedding
  }
}
```

- [ ] **步骤 5：编写工厂 `src/core/llm/index.ts`**

```typescript
import type { LlmProvider } from './types.js'
import { OpenAiProvider } from './openai-provider.js'

let provider: LlmProvider | null = null

export function getLlmProvider(): LlmProvider {
  if (!provider) {
    provider = new OpenAiProvider()
  }
  return provider
}

export function setLlmProvider(p: LlmProvider): void {
  provider = p
}

export type { LlmProvider, ChatMessage, ChatOptions, ChatResponse } from './types.js'
```

- [ ] **步骤 6：运行测试验证通过**

运行：`pnpm test src/core/llm/openai-provider.test.ts`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/core/llm
git commit -m "feat(llm): add unified LLM provider abstraction with OpenAI"
```

---

## 任务 5：Workspace 服务（CRUD + API Key）

**文件：**
- 创建：`src/core/workspace/service.ts`
- 测试：`src/core/workspace/service.test.ts`

- [ ] **步骤 1：编写失败的测试 `src/core/workspace/service.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWorkspaceService } from './service.js'

function mockPrisma(overrides: Record<string, any> = {}) {
  return {
    workspace: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'ws-1',
        name: args.data.name,
        defaultBrandName: args.data.defaultBrandName,
        apiKeyHash: args.data.apiKeyHash,
        status: 'ACTIVE',
        ...overrides,
      })),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  } as any
}

describe('workspace service', () => {
  let prisma: ReturnType<typeof mockPrisma>
  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('create 生成随机 apiKey 并哈希存储', async () => {
    const svc = createWorkspaceService(prisma)
    const result = await svc.create({ name: 'zoomer', defaultBrandName: 'zoomer AI' })
    expect(result.workspace.id).toBe('ws-1')
    expect(result.apiKey).toMatch(/^geo_/)
    expect(prisma.workspace.create).toHaveBeenCalled()
    const stored = prisma.workspace.create.mock.calls[0][0].data
    expect(stored.apiKeyHash).not.toMatch(/^geo_/)
  })

  it('findByApiKey 根据 key 查找并校验', async () => {
    prisma.workspace.findFirst.mockResolvedValue({ id: 'ws-1', apiKeyHash: 'hash', status: 'ACTIVE' })
    const svc = createWorkspaceService(prisma)
    const found = await svc.findByApiKey('geo_xxx')
    expect(found?.id).toBe('ws-1')
  })

  it('SUSPENDED 的 workspace 不返回', async () => {
    prisma.workspace.findFirst.mockResolvedValue(null)
    const svc = createWorkspaceService(prisma)
    const found = await svc.findByApiKey('geo_bad')
    expect(found).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/core/workspace/service.test.ts`
预期：FAIL，找不到 `./service.js`。

- [ ] **步骤 3：编写实现 `src/core/workspace/service.ts`**

```typescript
import { createHash, randomBytes } from 'node:crypto'
import type { PrismaClient, Workspace } from '@prisma/client'

export interface CreateWorkspaceInput {
  name: string
  defaultBrandName: string
  domain?: string
  llmsTxtUrl?: string
  platformConfig?: Record<string, unknown>
}

export interface WorkspaceService {
  create(input: CreateWorkspaceInput): Promise<{ workspace: Workspace; apiKey: string }>
  findByApiKey(apiKey: string): Promise<Workspace | null>
  getById(id: string): Promise<Workspace | null>
  updatePlatformConfig(id: string, config: Record<string, unknown>): Promise<Workspace>
}

export function createWorkspaceService(prisma: PrismaClient): WorkspaceService {
  function hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex')
  }

  return {
    async create(input) {
      const apiKey = 'geo_' + randomBytes(24).toString('hex')
      const workspace = await prisma.workspace.create({
        data: {
          name: input.name,
          defaultBrandName: input.defaultBrandName,
          domain: input.domain,
          llmsTxtUrl: input.llmsTxtUrl,
          apiKeyHash: hashKey(apiKey),
          platformConfig: (input.platformConfig as any) || {},
        },
      })
      return { workspace, apiKey }
    },

    async findByApiKey(apiKey) {
      return prisma.workspace.findFirst({
        where: { apiKeyHash: hashKey(apiKey), status: 'ACTIVE' },
      })
    },

    async getById(id) {
      return prisma.workspace.findUnique({ where: { id } })
    },

    async updatePlatformConfig(id, config) {
      return prisma.workspace.update({
        where: { id },
        data: { platformConfig: config as any },
      })
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/core/workspace/service.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/core/workspace/service.ts src/core/workspace/service.test.ts
git commit -m "feat(workspace): add workspace CRUD and API key management"
```

---

## 任务 6：API Key 认证逻辑

**文件：**
- 创建：`src/core/workspace/auth.ts`
- 测试：`src/core/workspace/auth.test.ts`

- [ ] **步骤 1：编写失败的测试 `src/core/workspace/auth.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { resolveWorkspaceFromHeader } from './auth.js'

describe('auth', () => {
  it('无 header 返回 null', async () => {
    const svc = { findByApiKey: vi.fn() } as any
    const result = await resolveWorkspaceFromHeader(undefined, svc)
    expect(result).toBeNull()
  })

  it('有效 key 返回 workspace', async () => {
    const ws = { id: 'ws-1', name: 'test' }
    const svc = { findByApiKey: vi.fn().mockResolvedValue(ws) } as any
    const result = await resolveWorkspaceFromHeader('geo_secret', svc)
    expect(result).toEqual(ws)
    expect(svc.findByApiKey).toHaveBeenCalledWith('geo_secret')
  })

  it('无效 key 返回 null', async () => {
    const svc = { findByApiKey: vi.fn().mockResolvedValue(null) } as any
    const result = await resolveWorkspaceFromHeader('geo_bad', svc)
    expect(result).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/core/workspace/auth.test.ts`
预期：FAIL，找不到 `./auth.js`。

- [ ] **步骤 3：编写实现 `src/core/workspace/auth.ts`**

```typescript
import type { Workspace } from '@prisma/client'
import type { WorkspaceService } from './service.js'

export async function resolveWorkspaceFromHeader(
  apiKeyHeader: string | undefined,
  service: WorkspaceService,
): Promise<Workspace | null> {
  if (!apiKeyHeader) return null
  return service.findByApiKey(apiKeyHeader)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/core/workspace/auth.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/core/workspace/auth.ts src/core/workspace/auth.test.ts
git commit -m "feat(workspace): add API key auth resolver"
```

---

## 任务 7：tRPC 上下文与初始化 + Workspace 路由

**文件：**
- 创建：`src/core/trpc/context.ts`、`src/core/trpc/init.ts`、`src/core/workspace/router.ts`

- [ ] **步骤 1：创建 tRPC 初始化 `src/core/trpc/init.ts`**

```typescript
import { initTRPC, TRPCError } from '@trpc/server'
import type { Workspace } from '@prisma/client'

export interface Context {
  workspace: Workspace
}

const t = initTRPC.context<Context>().create()

export const router = t.router
export const publicProcedure = t.procedure

// 受保护过程：要求 workspace 已解析
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.workspace) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Missing or invalid API key' })
  }
  return next({ ctx })
})
```

- [ ] **步骤 2：创建上下文工厂 `src/core/trpc/context.ts`**

```typescript
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch'
import { getPrismaClient } from '../db/client.js'
import { createWorkspaceService } from '../workspace/service.js'
import { resolveWorkspaceFromHeader } from '../workspace/auth.js'
import type { Context } from './init.js'

export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<Partial<Context>> {
  const prisma = getPrismaClient()
  const workspaceService = createWorkspaceService(prisma)
  const apiKey = opts.req.headers.get('x-api-key') || undefined
  const workspace = await resolveWorkspaceFromHeader(apiKey, workspaceService)
  return { workspace: workspace ?? undefined }
}
```

- [ ] **步骤 3：创建 workspace 路由 `src/core/workspace/router.ts`**

```typescript
import { z } from 'zod'
import { router, publicProcedure } from '../trpc/init.js'
import { getPrismaClient } from '../db/client.js'
import { createWorkspaceService } from './service.js'

export const workspaceRouter = router({
  // 注册新 workspace（仅引导阶段开放，生产应加管理员鉴权）
  register: publicProcedure
    .input(z.object({
      name: z.string(),
      defaultBrandName: z.string(),
      domain: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const prisma = getPrismaClient()
      const svc = createWorkspaceService(prisma)
      const { workspace, apiKey } = await svc.create(input)
      return { workspaceId: workspace.id, apiKey }
    }),

  // 配置各 AI 平台凭证
  setPlatformConfig: publicProcedure
    .input(z.object({
      apiKey: z.string(),
      config: z.record(z.unknown()),
    }))
    .mutation(async ({ input }) => {
      const prisma = getPrismaClient()
      const svc = createWorkspaceService(prisma)
      const ws = await svc.findByApiKey(input.apiKey)
      if (!ws) throw new Error('Invalid API key')
      const updated = await svc.updatePlatformConfig(ws.id, input.config)
      return { ok: true }
    }),
})
```

- [ ] **步骤 4：Commit**

```bash
git add src/core/trpc src/core/workspace/router.ts
git commit -m "feat(trpc): add context, init, and workspace router"
```

---

## 任务 8：平台适配器接口与注册表

**文件：**
- 创建：`src/modules/citation-monitor/platform-adapters/types.ts`、`src/modules/citation-monitor/platform-adapters/registry.ts`
- 测试：`src/modules/citation-monitor/platform-adapters/registry.test.ts`

- [ ] **步骤 1：创建接口 `src/modules/citation-monitor/platform-adapters/types.ts`**

```typescript
export interface CitationEntry {
  url: string
  position: number
  snippet?: string
}

export interface PlatformResult {
  answer: string
  citations: CitationEntry[]
  mentionedBrands: string[]
}

export interface PlatformAdapter {
  name: string
  query(text: string, credentials: Record<string, string>): Promise<PlatformResult>
}
```

- [ ] **步骤 2：编写失败的测试 `src/modules/citation-monitor/platform-adapters/registry.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { createAdapterRegistry } from './registry.js'
import type { PlatformAdapter } from './types.js'

function fakeAdapter(name: string): PlatformAdapter {
  return {
    name,
    async query() {
      return { answer: '', citations: [], mentionedBrands: [] }
    },
  }
}

describe('adapter registry', () => {
  let registry: ReturnType<typeof createAdapterRegistry>
  beforeEach(() => {
    registry = createAdapterRegistry()
  })

  it('注册并按名称获取', () => {
    const adapter = fakeAdapter('openai')
    registry.register(adapter)
    expect(registry.get('openai')).toBe(adapter)
  })

  it('获取未注册的返回 undefined', () => {
    expect(registry.get('nope')).toBeUndefined()
  })

  it('list 返回所有名称', () => {
    registry.register(fakeAdapter('openai'))
    registry.register(fakeAdapter('perplexity'))
    expect(registry.list().sort()).toEqual(['openai', 'perplexity'])
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/registry.test.ts`
预期：FAIL，找不到 `./registry.js`。

- [ ] **步骤 4：编写实现 `src/modules/citation-monitor/platform-adapters/registry.ts`**

```typescript
import type { PlatformAdapter } from './types.js'

export interface AdapterRegistry {
  register(adapter: PlatformAdapter): void
  get(name: string): PlatformAdapter | undefined
  list(): string[]
}

export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<string, PlatformAdapter>()
  return {
    register(adapter) {
      adapters.set(adapter.name, adapter)
    },
    get(name) {
      return adapters.get(name)
    },
    list() {
      return Array.from(adapters.keys())
    },
  }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/registry.test.ts`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/modules/citation-monitor/platform-adapters/types.ts src/modules/citation-monitor/platform-adapters/registry.ts src/modules/citation-monitor/platform-adapters/registry.test.ts
git commit -m "feat(citation): add platform adapter interface and registry"
```

---

## 任务 9：OpenAI 平台适配器

**文件：**
- 创建：`src/modules/citation-monitor/platform-adapters/openai.ts`
- 测试：`src/modules/citation-monitor/platform-adapters/openai.test.ts`

OpenAI chat completions 不原生返回引用 URL，因此 `citations` 为空，`mentionedBrands` 从答案文本中正则提取。

- [ ] **步骤 1：编写失败的测试 `src/modules/citation-monitor/platform-adapters/openai.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAiAdapter } from './openai.js'

describe('OpenAiAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '推荐 zoomer AI 和 Figma。详情见 https://zoomer.top',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('返回答案文本', async () => {
    const adapter = new OpenAiAdapter()
    const result = await adapter.query('AI设计工具', {
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    })
    expect(result.answer).toContain('zoomer AI')
  })

  it('从答案提取 URL 作为 citations', async () => {
    const adapter = new OpenAiAdapter()
    const result = await adapter.query('AI设计工具', { OPENAI_API_KEY: 'sk-test' })
    expect(result.citations.length).toBeGreaterThan(0)
    expect(result.citations[0].url).toBe('https://zoomer.top')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/openai.test.ts`
预期：FAIL，找不到 `./openai.js`。

- [ ] **步骤 3：编写实现 `src/modules/citation-monitor/platform-adapters/openai.ts`**

```typescript
import type { PlatformAdapter, PlatformResult, CitationEntry } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class OpenAiAdapter implements PlatformAdapter {
  name = 'openai'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.OPENAI_API_KEY
    const baseUrl = credentials.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    const model = credentials.OPENAI_MODEL || 'gpt-4o-mini'

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: '你是一个客观的助手，请直接回答用户问题。' },
          { role: 'user', content: text },
        ],
      }),
    })
    if (!res.ok) {
      throw new Error(`OpenAI adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
    }
    const answer = json.choices[0].message.content

    const matches = [...answer.matchAll(URL_REGEX)]
    const citations: CitationEntry[] = matches.map((m, i) => ({
      url: m[0],
      position: i + 1,
    }))

    return { answer, citations, mentionedBrands: [] }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/openai.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/platform-adapters/openai.ts src/modules/citation-monitor/platform-adapters/openai.test.ts
git commit -m "feat(citation): add OpenAI platform adapter"
```

---

## 任务 10：Perplexity 平台适配器

**文件：**
- 创建：`src/modules/citation-monitor/platform-adapters/perplexity.ts`
- 测试：`src/modules/citation-monitor/platform-adapters/perplexity.test.ts`

Perplexity sonar 模型在响应中返回 `citations`（URL 数组），需映射到 `CitationEntry`。

- [ ] **步骤 1：编写失败的测试 `src/modules/citation-monitor/platform-adapters/perplexity.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PerplexityAdapter } from './perplexity.js'

describe('PerplexityAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'zoomer AI 是一款设计工具' } }],
            citations: ['https://zoomer.top', 'https://example.com/blog'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('解析答案与 citations 数组', async () => {
    const adapter = new PerplexityAdapter()
    const result = await adapter.query('AI设计工具', { PERPLEXITY_API_KEY: 'pplx-test' })
    expect(result.answer).toContain('zoomer AI')
    expect(result.citations).toHaveLength(2)
    expect(result.citations[0]).toEqual({ url: 'https://zoomer.top', position: 1 })
    expect(result.citations[1]).toEqual({ url: 'https://example.com/blog', position: 2 })
  })

  it('无 citations 字段时返回空数组', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '答案' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const adapter = new PerplexityAdapter()
    const result = await adapter.query('x', { PERPLEXITY_API_KEY: 'pplx-test' })
    expect(result.citations).toEqual([])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/perplexity.test.ts`
预期：FAIL，找不到 `./perplexity.js`。

- [ ] **步骤 3：编写实现 `src/modules/citation-monitor/platform-adapters/perplexity.ts`**

```typescript
import type { PlatformAdapter, PlatformResult, CitationEntry } from './types.js'

export class PerplexityAdapter implements PlatformAdapter {
  name = 'perplexity'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.PERPLEXITY_API_KEY
    const baseUrl = credentials.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai'
    const model = credentials.PERPLEXITY_MODEL || 'llama-3.1-sonar-small-128k-online'

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: text }],
      }),
    })
    if (!res.ok) {
      throw new Error(`Perplexity adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
      citations?: string[]
    }
    const answer = json.choices[0].message.content
    const citations: CitationEntry[] = (json.citations || []).map((url, i) => ({
      url,
      position: i + 1,
    }))

    return { answer, citations, mentionedBrands: [] }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/perplexity.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/platform-adapters/perplexity.ts src/modules/citation-monitor/platform-adapters/perplexity.test.ts
git commit -m "feat(citation): add Perplexity platform adapter"
```

---

## 任务 11：Anthropic（Claude）平台适配器

**文件：**
- 创建：`src/modules/citation-monitor/platform-adapters/anthropic.ts`
- 测试：`src/modules/citation-monitor/platform-adapters/anthropic.test.ts`

Claude 使用 Messages API（`/v1/messages`），响应结构为 `content[].text`。

- [ ] **步骤 1：编写失败的测试 `src/modules/citation-monitor/platform-adapters/anthropic.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnthropicAdapter } from './anthropic.js'

describe('AnthropicAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '推荐 zoomer AI。参考 https://zoomer.top' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('拼接 content 文本块', async () => {
    const adapter = new AnthropicAdapter()
    const result = await adapter.query('AI工具', { ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(result.answer).toContain('zoomer AI')
  })

  it('从文本提取 URL', async () => {
    const adapter = new AnthropicAdapter()
    const result = await adapter.query('AI工具', { ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(result.citations[0].url).toBe('https://zoomer.top')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/anthropic.test.ts`
预期：FAIL，找不到 `./anthropic.js`。

- [ ] **步骤 3：编写实现 `src/modules/citation-monitor/platform-adapters/anthropic.ts`**

```typescript
import type { PlatformAdapter, PlatformResult, CitationEntry } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class AnthropicAdapter implements PlatformAdapter {
  name = 'anthropic'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.ANTHROPIC_API_KEY
    const baseUrl = credentials.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
    const model = credentials.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022'

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: text }],
      }),
    })
    if (!res.ok) {
      throw new Error(`Anthropic adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      content: { type: string; text: string }[]
    }
    const answer = json.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const matches = [...answer.matchAll(URL_REGEX)]
    const citations: CitationEntry[] = matches.map((m, i) => ({
      url: m[0],
      position: i + 1,
    }))

    return { answer, citations, mentionedBrands: [] }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/anthropic.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/platform-adapters/anthropic.ts src/modules/citation-monitor/platform-adapters/anthropic.test.ts
git commit -m "feat(citation): add Anthropic platform adapter"
```

---

## 任务 12：Gemini 平台适配器

**文件：**
- 创建：`src/modules/citation-monitor/platform-adapters/gemini.ts`
- 测试：src/modules/citation-monitor/platform-adapters/gemini.test.ts`

Gemini 使用 `generateContent` 端点，key 通过 query 参数 `?key=` 传递，响应结构为 `candidates[].content.parts[].text`。

- [ ] **步骤 1：编写失败的测试 `src/modules/citation-monitor/platform-adapters/gemini.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GeminiAdapter } from './gemini.js'

describe('GeminiAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'zoomer AI 不错。https://zoomer.top' }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('拼接 parts 文本', async () => {
    const adapter = new GeminiAdapter()
    const result = await adapter.query('AI工具', { GEMINI_API_KEY: 'gem-test' })
    expect(result.answer).toContain('zoomer AI')
  })

  it('URL 通过 query 参数传递 key', async () => {
    const adapter = new GeminiAdapter()
    await adapter.query('AI工具', { GEMINI_API_KEY: 'gem-test' })
    const calledUrl = (fetch as any).mock.calls[0][0] as string
    expect(calledUrl).toContain('key=gem-test')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/gemini.test.ts`
预期：FAIL，找不到 `./gemini.js`。

- [ ] **步骤 3：编写实现 `src/modules/citation-monitor/platform-adapters/gemini.ts`**

```typescript
import type { PlatformAdapter, PlatformResult, CitationEntry } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class GeminiAdapter implements PlatformAdapter {
  name = 'gemini'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.GEMINI_API_KEY
    const baseUrl =
      credentials.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
    const model = credentials.GEMINI_MODEL || 'gemini-1.5-flash'

    const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
      }),
    })
    if (!res.ok) {
      throw new Error(`Gemini adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      candidates?: { content: { parts: { text: string }[] } }[]
    }
    const parts = json.candidates?.[0]?.content?.parts || []
    const answer = parts.map((p) => p.text).join('')

    const matches = [...answer.matchAll(URL_REGEX)]
    const citations: CitationEntry[] = matches.map((m, i) => ({
      url: m[0],
      position: i + 1,
    }))

    return { answer, citations, mentionedBrands: [] }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/gemini.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/platform-adapters/gemini.ts src/modules/citation-monitor/platform-adapters/gemini.test.ts
git commit -m "feat(citation): add Gemini platform adapter"
```

---

## 任务 13：DeepSeek 平台适配器

**文件：**
- 创建：`src/modules/citation-monitor/platform-adapters/deepseek.ts`
- 测试：`src/modules/citation-monitor/platform-adapters/deepseek.test.ts`

DeepSeek 使用 OpenAI 兼容的 chat completions 接口。

- [ ] **步骤 1：编写失败的测试 `src/modules/citation-monitor/platform-adapters/deepseek.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DeepSeekAdapter } from './deepseek.js'

describe('DeepSeekAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'zoomer AI。https://zoomer.top' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('返回答案并提取 URL', async () => {
    const adapter = new DeepSeekAdapter()
    const result = await adapter.query('AI工具', { DEEPSEEK_API_KEY: 'ds-test' })
    expect(result.answer).toContain('zoomer AI')
    expect(result.citations[0].url).toBe('https://zoomer.top')
  })

  it('使用 DeepSeek base url', async () => {
    const adapter = new DeepSeekAdapter()
    await adapter.query('x', { DEEPSEEK_API_KEY: 'ds-test' })
    const calledUrl = (fetch as any).mock.calls[0][0] as string
    expect(calledUrl).toContain('deepseek.com')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/deepseek.test.ts`
预期：FAIL，找不到 `./deepseek.js`。

- [ ] **步骤 3：编写实现 `src/modules/citation-monitor/platform-adapters/deepseek.ts`**

```typescript
import type { PlatformAdapter, PlatformResult, CitationEntry } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class DeepSeekAdapter implements PlatformAdapter {
  name = 'deepseek'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.DEEPSEEK_API_KEY
    const baseUrl = credentials.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
    const model = credentials.DEEPSEEK_MODEL || 'deepseek-chat'

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: 'user', content: text }],
      }),
    })
    if (!res.ok) {
      throw new Error(`DeepSeek adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
    }
    const answer = json.choices[0].message.content
    const matches = [...answer.matchAll(URL_REGEX)]
    const citations: CitationEntry[] = matches.map((m, i) => ({
      url: m[0],
      position: i + 1,
    }))
    return { answer, citations, mentionedBrands: [] }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/platform-adapters/deepseek.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/platform-adapters/deepseek.ts src/modules/citation-monitor/platform-adapters/deepseek.test.ts
git commit -m "feat(citation): add DeepSeek platform adapter"
```

---

## 任务 14：CitationAnalyzer（提及/排名/SOV 分析）

**文件：**
- 创建：`src/modules/citation-monitor/analyzer.ts`
- 测试：`src/modules/citation-monitor/analyzer.test.ts`

**职责：** 输入 `PlatformResult` + 品牌名 + 竞品列表，输出分析结果（品牌是否被提及、排名、竞品提及、SOV）。

- [ ] **步骤 1：编写失败的测试 `src/modules/citation-monitor/analyzer.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { analyzeCitation } from './analyzer.js'
import type { PlatformResult } from './platform-adapters/types.js'

function makeResult(answer: string): PlatformResult {
  return { answer, citations: [], mentionedBrands: [] }
}

describe('CitationAnalyzer', () => {
  it('检测品牌被提及（大小写不敏感）', () => {
    const result = analyzeCitation({
      platformResult: makeResult('推荐 Zoomer AI 给设计师'),
      brand: 'zoomer AI',
      competitors: ['figma'],
    })
    expect(result.brandMentioned).toBe(true)
  })

  it('品牌未被提及时 brandMentioned=false', () => {
    const result = analyzeCitation({
      platformResult: makeResult('推荐 Figma'),
      brand: 'zoomer AI',
      competitors: ['figma'],
    })
    expect(result.brandMentioned).toBe(false)
  })

  it('计算品牌排名（在所有提及品牌中的顺序）', () => {
    const result = analyzeCitation({
      platformResult: makeResult('第一是 Figma，第二是 zoomer AI，第三是 Sketch'),
      brand: 'zoomer AI',
      competitors: ['figma', 'sketch'],
    })
    expect(result.rankInAnswer).toBe(2)
  })

  it('计算 SOV（品牌提及次数 / 所有品牌提及总和）', () => {
    const result = analyzeCitation({
      platformResult: makeResult('zoomer AI 和 zoomer AI 以及 Figma'),
      brand: 'zoomer AI',
      competitors: ['figma'],
    })
    // zoomer AI 出现 2 次，figma 1 次，SOV = 2/3 ≈ 0.667
    expect(result.sovScore).toBeCloseTo(2 / 3, 2)
  })

  it('竞品列表标记每个竞品是否提及及其排名', () => {
    const result = analyzeCitation({
      platformResult: makeResult('zoomer AI 最好，Figma 次之'),
      brand: 'zoomer AI',
      competitors: ['figma', 'sketch'],
    })
    const figma = result.competitors.find((c) => c.brand === 'figma')
    const sketch = result.competitors.find((c) => c.brand === 'sketch')
    expect(figma?.mentioned).toBe(true)
    expect(figma?.rank).toBe(2)
    expect(sketch?.mentioned).toBe(false)
    expect(sketch?.rank).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/analyzer.test.ts`
预期：FAIL，找不到 `./analyzer.js`。

- [ ] **步骤 3：编写实现 `src/modules/citation-monitor/analyzer.ts`**

```typescript
import type { PlatformResult } from './platform-adapters/types.js'

export interface CompetitorMention {
  brand: string
  mentioned: boolean
  rank: number | null
}

export interface CitationAnalysis {
  brandMentioned: boolean
  rankInAnswer: number | null
  sovScore: number
  competitors: CompetitorMention[]
}

export interface AnalyzeInput {
  platformResult: PlatformResult
  brand: string
  competitors: string[]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countOccurrences(text: string, term: string): number {
  const re = new RegExp(escapeRegex(term), 'gi')
  return [...text.matchAll(re)].length
}

function firstIndex(text: string, term: string): number {
  return text.toLowerCase().indexOf(term.toLowerCase())
}

export function analyzeCitation(input: AnalyzeInput): CitationAnalysis {
  const { platformResult, brand, competitors } = input
  const answer = platformResult.answer

  // 收集所有品牌（主品牌 + 竞品）的出现信息
  const all = [brand, ...competitors]
  const stats = all.map((name) => ({
    name,
    count: countOccurrences(answer, name),
    firstIndex: firstIndex(answer, name),
  }))

  const mentioned = stats
    .filter((s) => s.count > 0)
    .sort((a, b) => a.firstIndex - b.firstIndex)

  // 主品牌
  const brandStat = stats[0]
  const brandMentioned = brandStat.count > 0
  const rankInAnswer = brandMentioned
    ? mentioned.findIndex((s) => s.name === brand) + 1
    : null

  // SOV = 主品牌提及次数 / 所有品牌提及总次数
  const totalMentions = stats.reduce((sum, s) => sum + s.count, 0)
  const sovScore = totalMentions > 0 ? brandStat.count / totalMentions : 0

  // 竞品
  const competitorResult: CompetitorMention[] = competitors.map((name) => {
    const s = stats.find((x) => x.name === name)!
    if (s.count === 0) return { brand: name, mentioned: false, rank: null }
    const rank = mentioned.findIndex((x) => x.name === name) + 1
    return { brand: name, mentioned: true, rank }
  })

  return { brandMentioned, rankInAnswer, sovScore, competitors: competitorResult }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/analyzer.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/analyzer.ts src/modules/citation-monitor/analyzer.test.ts
git commit -m "feat(citation): add citation analyzer for mention/rank/SOV"
```

---

## 任务 15：QueryLibrary（query 库管理）

**文件：**
- 创建：`src/modules/citation-monitor/query-library.ts`
- 测试：`src/modules/citation-monitor/query-library.test.ts`

**职责：** query 的增删查改 + 通过 LLM 批量生成 query。规格 `QuerySource` 枚举：`GOOGLE_SUGGEST`/`LLM_GENERATED`/`PAA`/`MANUAL`/`COMPETITOR`。

- [ ] **步骤 1：编写失败的测试 `src/modules/citation-monitor/query-library.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueryLibraryService } from './query-library.js'

function mockPrisma() {
  return {
    citationQuery: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'q-1',
        ...args.data,
        status: 'ACTIVE',
      })),
      findMany: vi.fn().mockResolvedValue([
        { id: 'q1', queryText: 'AI设计工具', status: 'ACTIVE', workspaceId: 'w1' },
      ]),
      update: vi.fn().mockImplementation(async (args: any) => ({
        id: args.where.id,
        ...args.data,
      })),
      delete: vi.fn().mockResolvedValue({ id: 'q1' }),
    },
  } as any
}

describe('query library service', () => {
  let prisma: ReturnType<typeof mockPrisma>
  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('addQuery 创建 MANUAL query', async () => {
    const svc = createQueryLibraryService(prisma)
    const q = await svc.addQuery({
      workspaceId: 'w1',
      queryText: 'AI设计工具',
      source: 'MANUAL',
    })
    expect(q.id).toBe('q-1')
    expect(prisma.citationQuery.create).toHaveBeenCalled()
    const data = prisma.citationQuery.create.mock.calls[0][0].data
    expect(data.source).toBe('MANUAL')
    expect(data.status).toBe('ACTIVE')
  })

  it('listActive 返回 ACTIVE 状态 query', async () => {
    const svc = createQueryLibraryService(prisma)
    const list = await svc.listActive('w1')
    expect(list).toHaveLength(1)
    expect(list[0].queryText).toBe('AI设计工具')
    expect(prisma.citationQuery.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'ACTIVE' },
    })
  })

  it('pauseQuery 设置状态为 PAUSED', async () => {
    const svc = createQueryLibraryService(prisma)
    await svc.pauseQuery('q1')
    expect(prisma.citationQuery.update).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { status: 'PAUSED' },
    })
  })

  it('generateQueries 调用 LLM 并批量创建', async () => {
    const llm = {
      name: 'test',
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify(['Q1', 'Q2', 'Q3']),
      }),
      embed: vi.fn(),
    }
    const svc = createQueryLibraryService(prisma, llm as any)
    const result = await svc.generateQueries({
      workspaceId: 'w1',
      topic: 'AI设计工具',
      count: 3,
    })
    expect(result).toHaveLength(3)
    expect(llm.chat).toHaveBeenCalled()
    expect(prisma.citationQuery.create).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/query-library.test.ts`
预期：FAIL，找不到 `./query-library.js`。

- [ ] **步骤 3：编写实现 `src/modules/citation-monitor/query-library.ts`**

```typescript
import type { PrismaClient, CitationQuery, QuerySource } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'

export interface AddQueryInput {
  workspaceId: string
  queryText: string
  source: QuerySource
  intent?: Record<string, unknown>
}

export interface GenerateQueriesInput {
  workspaceId: string
  topic: string
  count: number
}

export interface QueryLibraryService {
  addQuery(input: AddQueryInput): Promise<CitationQuery>
  listActive(workspaceId: string): Promise<CitationQuery[]>
  pauseQuery(id: string): Promise<CitationQuery>
  deleteQuery(id: string): Promise<void>
  generateQueries(input: GenerateQueriesInput): Promise<CitationQuery[]>
}

export function createQueryLibraryService(
  prisma: PrismaClient,
  llm?: LlmProvider,
): QueryLibraryService {
  return {
    async addQuery(input) {
      return prisma.citationQuery.create({
        data: {
          workspaceId: input.workspaceId,
          queryText: input.queryText,
          source: input.source,
          intent: (input.intent as any) || {},
          status: 'ACTIVE',
        },
      })
    },

    async listActive(workspaceId) {
      return prisma.citationQuery.findMany({
        where: { workspaceId, status: 'ACTIVE' },
      })
    },

    async pauseQuery(id) {
      return prisma.citationQuery.update({
        where: { id },
        data: { status: 'PAUSED' },
      })
    },

    async deleteQuery(id) {
      await prisma.citationQuery.delete({ where: { id } })
    },

    async generateQueries(input) {
      if (!llm) throw new Error('LLM provider required for generateQueries')
      const prompt = `为主题"${input.topic}"生成 ${input.count} 个用户可能在 AI 搜索引擎中提问的 query。
只输出 JSON 字符串数组，不要任何解释。例如：["query1","query2"]`

      const res = await llm.chat([{ role: 'user', content: prompt }], { temperature: 0.7 })
      let queries: string[]
      try {
        queries = JSON.parse(res.text)
      } catch {
        // 兜底：按行解析
        queries = res.text.split('\n').map((s) => s.trim()).filter(Boolean)
      }

      const created: CitationQuery[] = []
      for (const q of queries.slice(0, input.count)) {
        const row = await prisma.citationQuery.create({
          data: {
            workspaceId: input.workspaceId,
            queryText: q,
            source: 'LLM_GENERATED',
            status: 'ACTIVE',
          },
        })
        created.push(row)
      }
      return created
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/query-library.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/query-library.ts src/modules/citation-monitor/query-library.test.ts
git commit -m "feat(citation): add query library service with LLM generation"
```

---

## 任务 16：Monitor 编排器（监测调度）

**文件：**
- 创建：`src/modules/citation-monitor/monitor.ts`
- 测试：`src/modules/citation-monitor/monitor.test.ts`

**职责：** 编排单次监测流程：取 query → 调 adapter → 分析 → 写 `CitationEvent`。这是规格"监测流程"6 步的核心实现。

- [ ] **步骤 1：编写失败的测试 `src/modules/citation-monitor/monitor.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMonitor } from './monitor.js'
import type { PlatformResult } from './platform-adapters/types.js'

function mockPrisma() {
  return {
    citationEvent: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'ev-1',
        ...args.data,
      })),
    },
    workspace: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'w1',
        defaultBrandName: 'zoomer AI',
        platformConfig: {
          openai: { OPENAI_API_KEY: 'sk-test' },
        },
      }),
    },
  } as any
}

function mockQueryLibrary(queries: any[]) {
  return {
    listActive: vi.fn().mockResolvedValue(queries),
    addQuery: vi.fn(),
    pauseQuery: vi.fn(),
    deleteQuery: vi.fn(),
    generateQueries: vi.fn(),
  } as any
}

function mockAdapter(result: PlatformResult) {
  return {
    name: 'openai',
    query: vi.fn().mockResolvedValue(result),
  } as any
}

describe('monitor', () => {
  let prisma: ReturnType<typeof mockPrisma>

  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('对每个 query 调用 adapter 并写入 CitationEvent', async () => {
    const queries = [
      { id: 'q1', workspaceId: 'w1', queryText: 'AI设计工具', status: 'ACTIVE' },
    ]
    const adapter = mockAdapter({
      answer: '推荐 zoomer AI',
      citations: [],
      mentionedBrands: [],
    })
    const registry = { get: vi.fn().mockReturnValue(adapter), list: vi.fn().mockReturnValue(['openai']) } as any
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: mockQueryLibrary(queries),
      competitors: ['figma'],
    })

    const events = await monitor.runOnce({ workspaceId: 'w1', platforms: ['openai'] })

    expect(events).toHaveLength(1)
    expect(adapter.query).toHaveBeenCalledWith('AI设计工具', { OPENAI_API_KEY: 'sk-test' })
    expect(prisma.citationEvent.create).toHaveBeenCalled()
    const data = prisma.citationEvent.create.mock.calls[0][0].data
    expect(data.workspaceId).toBe('w1')
    expect(data.queryId).toBe('q1')
    expect(data.platform).toBe('openai')
    expect(data.brandMentioned).toBe(true)
    expect(data.sovScore).toBe(1)
  })

  it('adapter 抛错时记录失败但不中断整体', async () => {
    const queries = [
      { id: 'q1', workspaceId: 'w1', queryText: 'Q1', status: 'ACTIVE' },
      { id: 'q2', workspaceId: 'w1', queryText: 'Q2', status: 'ACTIVE' },
    ]
    const failing = { name: 'openai', query: vi.fn().mockRejectedValue(new Error('boom')) } as any
    const registry = { get: vi.fn().mockReturnValue(failing), list: vi.fn().mockReturnValue(['openai']) } as any
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: mockQueryLibrary(queries),
      competitors: [],
    })

    const events = await monitor.runOnce({ workspaceId: 'w1', platforms: ['openai'] })
    expect(events).toHaveLength(0)
    expect(failing.query).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/monitor.test.ts`
预期：FAIL，找不到 `./monitor.js`。

- [ ] **步骤 3：编写实现 `src/modules/citation-monitor/monitor.ts`**

```typescript
import type { PrismaClient, CitationEvent } from '@prisma/client'
import type { AdapterRegistry } from './platform-adapters/registry.js'
import type { QueryLibraryService } from './query-library.js'
import { analyzeCitation } from './analyzer.js'

export interface MonitorDeps {
  prisma: PrismaClient
  registry: AdapterRegistry
  queryLibrary: QueryLibraryService
  competitors: string[]
  concurrency?: number
}

export interface RunOnceInput {
  workspaceId: string
  platforms: string[]
}

export interface Monitor {
  runOnce(input: RunOnceInput): Promise<CitationEvent[]>
}

export function createMonitor(deps: MonitorDeps): Monitor {
  const concurrency = deps.concurrency ?? 3

  async function processOne(
    query: { id: string; workspaceId: string; queryText: string },
    platform: string,
    workspace: { defaultBrandName: string; platformConfig: any },
  ): Promise<CitationEvent | null> {
    const adapter = deps.registry.get(platform)
    if (!adapter) return null
    const credentials = workspace.platformConfig?.[platform] || {}
    try {
      const platformResult = await adapter.query(query.queryText, credentials)
      const analysis = analyzeCitation({
        platformResult,
        brand: workspace.defaultBrandName,
        competitors: deps.competitors,
      })
      return deps.prisma.citationEvent.create({
        data: {
          workspaceId: query.workspaceId,
          queryId: query.id,
          platform,
          brandMentioned: analysis.brandMentioned,
          rankInAnswer: analysis.rankInAnswer,
          citedUrls: platformResult.citations as any,
          competitors: analysis.competitors as any,
          rawAnswer: platformResult.answer,
          sovScore: analysis.sovScore,
        },
      })
    } catch (err) {
      console.error(`[monitor] query=${query.id} platform=${platform} failed:`, err)
      return null
    }
  }

  return {
    async runOnce(input) {
      const workspace = await deps.prisma.workspace.findUnique({
        where: { id: input.workspaceId },
      })
      if (!workspace) throw new Error(`Workspace not found: ${input.workspaceId}`)

      const queries = await deps.queryLibrary.listActive(input.workspaceId)
      const tasks: Promise<CitationEvent | null>[] = []
      for (const q of queries) {
        for (const platform of input.platforms) {
          tasks.push(processOne(q, platform, workspace as any))
        }
      }
      // 简单并发控制：分批
      const results: (CitationEvent | null)[] = []
      for (let i = 0; i < tasks.length; i += concurrency) {
        const batch = tasks.slice(i, i + concurrency)
        results.push(...(await Promise.all(batch)))
      }
      return results.filter((r): r is CitationEvent => r !== null)
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/monitor.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/monitor.ts src/modules/citation-monitor/monitor.test.ts
git commit -m "feat(citation): add monitor orchestrator for citation tracking"
```

---

## 任务 17：Citation tRPC 路由 + 报告查询

**文件：**
- 创建：`src/modules/citation-monitor/router.ts`
- 测试：`src/modules/citation-monitor/router.test.ts`

**职责：** 暴露 SDK 调用的 API：`trackQuery`（手动触发单次监测）、`batchTrack`、`getReport`、`getSovScore`、`queries.list/add/generate`。

- [ ] **步骤 1：编写失败的测试 `src/modules/citation-monitor/router.test.ts`**

测试策略：直接调用 router 的 procedure handler（tRPC 内部可调用 `.createCaller`）。

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { citationRouter } from './router.js'

function createCaller(ctx: any) {
  return citationRouter.createCaller(ctx)
}

describe('citation router', () => {
  const mockMonitor = { runOnce: vi.fn().mockResolvedValue([{ id: 'ev1' }]) }
  const mockQueryLibrary = {
    listActive: vi.fn().mockResolvedValue([{ id: 'q1' }]),
    addQuery: vi.fn().mockResolvedValue({ id: 'q2' }),
    generateQueries: vi.fn().mockResolvedValue([{ id: 'q3' }]),
  }
  const mockPrisma = {
    citationEvent: {
      findMany: vi.fn().mockResolvedValue([
        { platform: 'openai', brandMentioned: true, sovScore: 0.5, capturedAt: new Date() },
      ]),
    },
  }

  const ctx = {
    workspace: { id: 'w1', defaultBrandName: 'zoomer AI' },
    services: {
      monitor: mockMonitor,
      queryLibrary: mockQueryLibrary,
      prisma: mockPrisma,
    },
  } as any

  beforeEach(() => vi.clearAllMocks())

  it('trackQuery 触发监测', async () => {
    const caller = createCaller(ctx)
    const result = await caller.trackQuery({
      query: 'AI设计工具',
      brand: 'zoomer AI',
      platforms: ['openai'],
    })
    expect(mockMonitor.runOnce).toHaveBeenCalled()
    expect(result.events).toHaveLength(1)
  })

  it('queries.add 添加 query', async () => {
    const caller = createCaller(ctx)
    const result = await caller.queries.add({
      queryText: '新 query',
      source: 'manual',
    })
    expect(mockQueryLibrary.addQuery).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', queryText: '新 query' }),
    )
  })

  it('getReport 返回时间范围内事件', async () => {
    const caller = createCaller(ctx)
    const result = await caller.getReport({
      dateRange: { start: '2026-06-01', end: '2026-06-13' },
    })
    expect(mockPrisma.citationEvent.findMany).toHaveBeenCalled()
    expect(result.events).toHaveLength(1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/modules/citation-monitor/router.test.ts`
预期：FAIL，找不到 `./router.js`。

- [ ] **步骤 3：编写实现 `src/modules/citation-monitor/router.ts`**

```typescript
import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

export const citationRouter = router({
  // 手动触发单次监测
  trackQuery: protectedProcedure
    .input(z.object({
      query: z.string(),
      brand: z.string().optional(),
      platforms: z.array(z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const events = await ctx.services.monitor.runOnce({
        workspaceId: ctx.workspace.id,
        platforms: input.platforms,
      })
      return { events }
    }),

  // 批量监测（同 trackQuery，platforms 作用于全部）
  batchTrack: protectedProcedure
    .input(z.object({
      queries: z.array(z.string()),
      platforms: z.array(z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const events = await ctx.services.monitor.runOnce({
        workspaceId: ctx.workspace.id,
        platforms: input.platforms,
      })
      return { events }
    }),

  // 查询报告
  getReport: protectedProcedure
    .input(z.object({
      dateRange: z.object({ start: z.string(), end: z.string() }),
      platform: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const where: any = {
        workspaceId: ctx.workspace.id,
        capturedAt: {
          gte: new Date(input.dateRange.start),
          lte: new Date(input.dateRange.end),
        },
      }
      if (input.platform) where.platform = input.platform
      const events = await ctx.services.prisma.citationEvent.findMany({ where })
      return { events }
    }),

  // SOV 分数
  getSovScore: protectedProcedure
    .input(z.object({
      competitors: z.array(z.string()),
      dateRange: z.object({ start: z.string(), end: z.string() }),
    }))
    .query(async ({ ctx, input }) => {
      const events = await ctx.services.prisma.citationEvent.findMany({
        where: {
          workspaceId: ctx.workspace.id,
          capturedAt: {
            gte: new Date(input.dateRange.start),
            lte: new Date(input.dateRange.end),
          },
        },
      })
      const mentioned = events.filter((e: any) => e.brandMentioned).length
      const sovScore = events.length > 0 ? mentioned / events.length : 0
      return { sovScore, totalEvents: events.length, mentionedCount: mentioned }
    }),

  // query 库管理
  queries: router({
    list: protectedProcedure
      .input(z.object({ status: z.enum(['active', 'paused']).optional() }).optional())
      .query(async ({ ctx }) => {
        return ctx.services.queryLibrary.listActive(ctx.workspace.id)
      }),

    add: protectedProcedure
      .input(z.object({
        queryText: z.string(),
        source: z.enum(['manual', 'google_suggest', 'llm_generated', 'paa', 'competitor']),
        intent: z.record(z.unknown()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.addQuery({
          workspaceId: ctx.workspace.id,
          queryText: input.queryText,
          source: input.source.toUpperCase() as any,
          intent: input.intent,
        })
      }),

    generate: protectedProcedure
      .input(z.object({
        topic: z.string(),
        count: z.number().min(1).max(100),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.generateQueries({
          workspaceId: ctx.workspace.id,
          topic: input.topic,
          count: input.count,
        })
      }),
  }),
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/modules/citation-monitor/router.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/citation-monitor/router.ts src/modules/citation-monitor/router.test.ts
git commit -m "feat(citation): add tRPC router with track/report/query APIs"
```

---

## 任务 18：citation-scheduler 定时任务 worker

**文件：**
- 创建：`src/workers/citation-scheduler.ts`
- 测试：`src/workers/citation-scheduler.test.ts`

**职责：** 注册 pg-boss 定时任务，默认每日触发一次，遍历所有 ACTIVE workspace 执行 `monitor.runOnce`。

- [ ] **步骤 1：编写失败的测试 `src/workers/citation-scheduler.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startCitationScheduler } from './citation-scheduler.js'

describe('citation scheduler', () => {
  let boss: any
  let deps: any

  beforeEach(() => {
    boss = {
      schedule: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    }
    deps = {
      boss,
      prisma: {
        workspace: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'w1', status: 'ACTIVE', platformConfig: { openai: {} } },
            { id: 'w2', status: 'ACTIVE', platformConfig: { perplexity: {} } },
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test src/workers/citation-scheduler.test.ts`
预期：FAIL，找不到 `./citation-scheduler.js`。

- [ ] **步骤 3：编写实现 `src/workers/citation-scheduler.ts`**

```typescript
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test src/workers/citation-scheduler.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/workers/citation-scheduler.ts src/workers/citation-scheduler.test.ts
git commit -m "feat(workers): add daily citation scheduler"
```

---

## 任务 19：总路由 + Fastify Server 启动

**文件：**
- 创建：`src/router.ts`、`src/server.ts`

**职责：** 组装所有子路由为 `appRouter`，启动 Fastify + tRPC + pg-boss scheduler。

- [ ] **步骤 1：创建总路由 `src/router.ts`**

```typescript
import { router } from './core/trpc/init.js'
import { workspaceRouter } from './core/workspace/router.js'
import { citationRouter } from './modules/citation-monitor/router.js'

export const appRouter = router({
  workspace: workspaceRouter,
  citation: citationRouter,
})

export type AppRouter = typeof appRouter
```

- [ ] **步骤 2：创建 server 入口 `src/server.ts`**

```typescript
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
  // 通过闭包扩展 createContext 返回的对象
  const services = { prisma, monitor, queryLibrary }

  const fastify = Fastify({ logger: true })
  await fastify.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async (opts) => {
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
```

- [ ] **步骤 3：类型检查通过**

运行：`pnpm tsc --noEmit`
预期：无类型错误。

- [ ] **步骤 4：Commit**

```bash
git add src/router.ts src/server.ts
git commit -m "feat(server): add fastify entry and tRPC app router"
```

---

## 任务 20：SDK 包（@scope/geo-sdk）

**文件：**
- 创建：`sdk/package.json`、`sdk/tsconfig.json`、`sdk/src/types.ts`、`sdk/src/client.ts`、`sdk/src/index.ts`

**职责：** 通过 tRPC 的 `httpBatchLink` 接入服务端，类型从 `AppRouter` 自动推导。对接入系统提供端到端类型提示。

- [ ] **步骤 1：创建 `sdk/package.json`**

```json
{
  "name": "@scope/geo-sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@trpc/client": "^10.45.0",
    "@trpc/server": "^10.45.0"
  }
}
```

- [ ] **步骤 2：创建 `sdk/tsconfig.json`**

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **步骤 3：创建 `sdk/src/types.ts`**

```typescript
// 从服务端 AppRouter 推导类型（构建时通过路径映射解析）
import type { AppRouter } from '../../../src/router.js'

export type GeoAppRouter = AppRouter
```

- [ ] **步骤 4：创建 `sdk/src/client.ts`**

```typescript
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { GeoAppRouter } from './types.js'

export interface CreateGeoClientOptions {
  serviceUrl: string
  apiKey: string
  webhookUrl?: string
}

export function createGeoClient(options: CreateGeoClientOptions) {
  return createTRPCProxyClient<GeoAppRouter>({
    links: [
      httpBatchLink({
        url: `${options.serviceUrl}/trpc`,
        headers: () => ({
          'x-api-key': options.apiKey,
        }),
      }),
    ],
  })
}
```

- [ ] **步骤 5：创建 `sdk/src/index.ts`**

```typescript
export { createGeoClient } from './client.js'
export type { CreateGeoClientOptions } from './client.js'
export type { GeoAppRouter } from './types.js'
```

- [ ] **步骤 6：验证 SDK 类型可推导**

运行：`pnpm tsc --noEmit -p sdk/tsconfig.json`
预期：无类型错误。

- [ ] **步骤 7：Commit**

```bash
git add sdk
git commit -m "feat(sdk): add @scope/geo-sdk client with tRPC type inference"
```

---

## 任务 21：端到端集成验证

**文件：**
- 创建：`tests/e2e-citation-flow.test.ts`（在真实 PostgreSQL 上验证完整流程）

**职责：** 验证规格落地路线"阶段 1"的 MVP 验收——注册 workspace → 录入 query → 触发监测（mock 平台响应）→ 查询报告，全链路跑通。

- [ ] **步骤 1：启动依赖数据库**

运行：`docker compose up -d`
预期：pgvector 容器启动。

运行：`pnpm db:push && pnpm exec tsx prisma/sql/0001_pgvector.sql`（或通过 `psql` 执行 SQL）
预期：表与索引创建成功。

- [ ] **步骤 2：编写集成测试 `tests/e2e-citation-flow.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { getPrismaClient, resetPrismaClient } from '../src/core/db/client.js'
import { createWorkspaceService } from '../src/core/workspace/service.js'
import { createQueryLibraryService } from '../src/modules/citation-monitor/query-library.js'
import { createMonitor } from '../src/modules/citation-monitor/monitor.js'
import { createAdapterRegistry } from '../src/modules/citation-monitor/platform-adapters/registry.js'

// 内嵌假 adapter，避免真实 API 调用
class FakeAdapter {
  name = 'openai'
  async query() {
    return {
      answer: '推荐 zoomer AI，它是一款设计工具。参考 https://zoomer.top',
      citations: [{ url: 'https://zoomer.top', position: 1 }],
      mentionedBrands: [],
    }
  }
}

describe('e2e: citation flow', () => {
  let apiKey: string
  let workspaceId: string

  beforeAll(async () => {
    const prisma = getPrismaClient()
    // 清理（开发库）
    await prisma.citationEvent.deleteMany()
    await prisma.citationQuery.deleteMany()
    await prisma.workspace.deleteMany()

    const ws = createWorkspaceService(prisma)
    const { workspace, apiKey: key } = await ws.create({
      name: 'test',
      defaultBrandName: 'zoomer AI',
    })
    workspaceId = workspace.id
    apiKey = key
  })

  it('注册 → 录入 query → 监测 → 报告', async () => {
    const prisma = getPrismaClient()
    const queryLib = createQueryLibraryService(prisma)
    const q = await queryLib.addQuery({
      workspaceId,
      queryText: 'AI设计工具哪个好',
      source: 'MANUAL',
    })

    const registry = createAdapterRegistry()
    registry.register(new FakeAdapter() as any)
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: queryLib,
      competitors: ['figma'],
    })

    const events = await monitor.runOnce({ workspaceId, platforms: ['openai'] })
    expect(events).toHaveLength(1)
    expect(events[0].brandMentioned).toBe(true)

    // 验证报告查询
    const reportEvents = await prisma.citationEvent.findMany({
      where: { workspaceId },
    })
    expect(reportEvents).toHaveLength(1)
    expect(reportEvents[0].sovScore).toBeGreaterThan(0)
  })
})
```

- [ ] **步骤 3：运行集成测试**

运行：`pnpm test tests/e2e-citation-flow.test.ts`
预期：PASS（依赖本地 PostgreSQL + pgvector 已启动）。

- [ ] **步骤 4：运行全量测试套件**

运行：`pnpm test`
预期：所有单元测试 + 集成测试 PASS。

- [ ] **步骤 5：Commit**

```bash
git add tests/e2e-citation-flow.test.ts
git commit -m "test(e2e): verify full citation monitoring flow"
```

---

## 验收对照（规格"阶段 1"）

| 规格要求 | 对应任务 |
|---|---|
| 搭建 geo-service 骨架（Fastify + tRPC + Prisma + pg-boss） | 任务 1, 2, 3, 19 |
| workspace 管理 + API Key 认证 | 任务 5, 6, 7 |
| 5 个平台 adapter（OpenAI、Perplexity、Claude、Gemini、DeepSeek） | 任务 8, 9, 10, 11, 12, 13 |
| query 库管理（手动录入 + LLM 生成） | 任务 15 |
| pg-boss 定时监测任务 | 任务 18 |
| CitationAnalyzer（品牌提及、排名、SOV） | 任务 14 |
| 基础报告 API | 任务 17 |
| SDK 基础封装 | 任务 20 |
| 端到端验证 baseline 数据 | 任务 21 |

**未覆盖（属于后续阶段）：** Content Optimizer、Schema Generator、Knowledge Graph、OptimizationTask 闭环、Webhook、embedding 写入（任务 4 提供 embed 能力，但 CitationEvent.embedding 的实际写入需向量列支持，留作阶段 2 联调）。

---

## 自检

**1. 规格覆盖度（阶段 1 范围）：**
- 一、项目概述 → 架构选型 → 技术栈：任务 1 的 `package.json` + `tsconfig.json` 覆盖。
- 二、整体架构 → 目录结构：任务 1-20 创建了规格 2.3 目录结构中阶段 1 相关的所有文件。
- 三、数据模型 → Prisma Schema：任务 2 的 `schema.prisma` 包含 `Workspace`、`CitationQuery`、`CitationEvent` 及相关枚举。向量索引在 `0001_pgvector.sql`。
- 四、SDK 接口 → 初始化 + 引用监测接口：任务 20 的 `createGeoClient`，任务 17 的 `citationRouter` 覆盖 `trackQuery`/`batchTrack`/`getReport`/`getSovScore`/`queries.list/add/generate`。
- 五、模块 1 Citation Monitor → 平台适配器接口 + 监测流程：任务 8（接口）、任务 9-13（5 个 adapter）、任务 14（analyzer）、任务 16（monitor 编排）完整覆盖规格 5.1 的 6 步流程。
- 六、数据反馈闭环（阶段 1 部分）：定时监测在任务 18，闭环的"发现问题→优化"属阶段 2。
- 七、接入方式：任务 20 SDK + 任务 5 workspace 注册覆盖。
- 八、安全与合规：API Key 哈希存储在任务 5，`raw_answer` 按 workspace 隔离由 Prisma 查询 where 保证。
- 九、落地路线 → 阶段 1 所有条目：上方验收对照表已逐项映射。

**2. 占位符扫描：** 计划中无 TODO / 待定 / "类似任务 N" / "添加适当错误处理"。每个步骤都包含完整代码或精确命令。唯一的"后续阶段"说明在验收对照中明确标注范围边界，非占位符。

**3. 类型一致性：**
- `PlatformAdapter` 接口（任务 8 `types.ts`）的 `query(text, credentials)` 签名在任务 9-13 的 5 个 adapter 实现中保持一致。
- `PlatformResult` 的 `answer/citations/mentionedBrands` 字段在 analyzer（任务 14）、monitor（任务 16）、router（任务 17）中一致使用。
- `CitationAnalysis` 的 `brandMentioned/rankInAnswer/sovScore/competitors` 在 monitor 写入 `CitationEvent` 时与 Prisma schema 字段名对齐。
- `QueryLibraryService` 接口（任务 15）的 `addQuery/listActive/pauseQuery/generateQueries` 在 router（任务 17）和 monitor（任务 16）调用处签名一致。
- `MonitorDeps`（任务 16）的 `registry` 类型为 `AdapterRegistry`（任务 8），`queryLibrary` 类型为 `QueryLibraryService`（任务 15），跨任务类型引用一致。
- tRPC context 的 `services` 对象（任务 19 server.ts 注入）与 router handler（任务 17）中 `ctx.services.monitor/queryLibrary/prisma` 访问路径一致。

**无遗漏，无需补充任务。**

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-13-geo-phase1-citation-monitor.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？