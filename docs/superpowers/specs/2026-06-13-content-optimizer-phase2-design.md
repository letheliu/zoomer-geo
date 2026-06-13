# Content Optimizer 阶段 2 设计

> **上游规格：** `docs/superpowers/specs/2026-06-13-geo-system-design.md` 第九章"阶段 2"
> **前置条件：** 阶段 1（基础设施 + Citation Monitor）已完成并合并到 main，43 个测试全部通过

---

## 一、设计决策摘要

| 决策项 | 选定方案 | 理由 |
|--------|---------|------|
| LLM 调用策略 | 分步流水线（每组件独立调用 LLM） | 职责清晰、可独立测试、单步失败可重试 |
| FAQ query 来源 | 两种都支持（CitationQuery 库优先，回退 LLM 生成） | 复用阶段 1 数据，同时保持独立可用 |
| 评分实现方式 | 纯规则评分（正则 + 启发式） | 确定性、快速、可测试，无需 LLM |
| 审核流程范围 | 状态机 + review API（不含 webhook） | webhook 是阶段 4 范围 |

---

## 二、模块架构

### 2.1 流水线数据流

```
ContentPage (输入)
     │
     ▼
ContentAtomizer ──LLM──► Atom[] (subject/predicate/object/anchors)
     │
     ▼
ScoringEngine ──规则──► ScoredAtom[] (每个 atom 附带 0-100 分)
     │
     ├─ 达标 (≥70) ──► 直接进入下一步
     │
     └─ 不达标 (<70) ─► LlmRewriter ──LLM──► 重写后的 Atom (重新评分)
                                                    │
                                                    ▼
                                        FaqGenerator ──LLM──► FaqPair[]
                                                    │
                                                    ▼
                                        组装 OptimizationResult
                                                    │
                                                    ▼
                                        写入 ContentPage + 创建 OptimizationTask (PENDING)
```

### 2.2 组件职责边界

| 组件 | 输入 | 输出 | 用 LLM | 依赖 |
|------|------|------|--------|------|
| `ContentAtomizer` | 原始文本 | `Atom[]` | 是 | LlmProvider |
| `ScoringEngine` | `Atom[]` | `ScoredAtom[]` | 否 | 无 |
| `LlmRewriter` | 不达标的 `ScoredAtom[]` | 重写后的 `ScoredAtom[]` | 是 | LlmProvider |
| `FaqGenerator` | `Atom[]` + 可选 query 列表 | `FaqPair[]` | 是 | LlmProvider, 可选 PrismaClient |
| `OptimizationTaskService` | 优化结果 | `OptimizationTask` 记录 | 否 | PrismaClient |
| `AtomizerOrchestrator` | 优化请求 | `OptimizationResult` | 否（编排） | 上述全部组件 |

### 2.3 设计原则

- **工厂函数模式**：每个组件是 `createXxx(deps)` 工厂，与阶段 1 的 `createQueryLibraryService` 模式一致
- **依赖注入**：组件之间通过明确的数据结构通信，不共享内部状态
- **可独立测试**：LLM 调用通过 mock `LlmProvider` 替换，Prisma 通过 mock `PrismaClient` 替换
- **ScoringEngine 零依赖**：纯规则评分，完全确定性

---

## 三、核心数据结构

### 3.1 Atom（内容原子单元）

```typescript
interface Atom {
  text: string              // 段落原文（或重写后文本）
  subject: string           // 这段在说谁，如 "zoomer AI"
  predicate: string         // 说了什么（动词），如 "支持"
  object: string            // 对象，如 "AI 设计工具"
  anchors: string[]         // 数据锚点：数字、时间、机构名，如 ["2024年", "50万用户"]
  definition?: string       // 定义句（subject + is + value），可选
}
```

### 3.2 ScoredAtom（评分后的原子单元）

```typescript
interface ScoredAtom extends Atom {
  score: AtomScore
}

interface AtomScore {
  total: number              // 0-100，加权总分
  hasNumericAnchor: boolean  // 含数字/时间锚点（权重 35）
  hasEntityAnchor: boolean   // 含机构名/专有名词锚点（权重 25）
  isSelfContained: boolean   // 切出后能自解释（权重 25）
  hasDefinition: boolean     // 含定义句（权重 15）
}
```

### 3.3 评分规则

| 维度 | 检测方法 | 权重 | 分值 |
|------|---------|------|------|
| 数字锚点 | 正则匹配 `\d+`、日期模式、百分比、货币 | 35 | 命中=35，未命中=0 |
| 实体锚点 | `anchors` 数组中存在非纯数字条目 | 25 | 命中=25，未命中=0 |
| 自解释 | `subject` + `predicate` + `object` 三者都非空 | 25 | 全非空=25，缺一=0 |
| 定义句 | `definition` 字段非空 | 15 | 有=15，无=0 |

- **达标阈值：total >= 70** → 不需要重写
- **不达标：total < 70** → 交给 LlmRewriter
- **页面整体评分：** 所有 atom 的 `score.total` 平均值

### 3.4 FaqPair（问答对）

```typescript
interface FaqPair {
  question: string
  answer: string
  matchedQueryId?: string   // 如果匹配到 CitationQuery，记录关联
  source: 'citation_query' | 'llm_generated'
}
```

### 3.5 OptimizationResult（流水线最终输出）

```typescript
interface OptimizationResult {
  atoms: ScoredAtom[]        // 最终的原子单元（含重写后的）
  faqs: FaqPair[]            // 生成的 FAQ
  overallScore: number       // 页面整体评分（所有 atom 平均分）
  rewrittenCount: number     // 被重写的 atom 数量
  report: {
    atomizationRate: number  // 原子化率（达标 atom / 总 atom）
    independenceRate: number // 切片独立性（自解释 atom / 总 atom）
    faqCoverage: number     // FAQ 覆盖度（匹配到 query 的 FAQ / 总 FAQ）
  }
}
```

---

## 四、数据库变更

### 4.1 新增模型

在 `prisma/schema.prisma` 中新增以下模型，并更新 Workspace 关联。

```prisma
// ============ 模块 2：内容优化 ============

model ContentPage {
  id                String        @id @default(cuid())
  workspaceId       String
  workspace         Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  url               String
  pageType          String                        // landing / about / pricing / blog
  currentContent    String        @db.Text
  optimizedContent  String?       @db.Text        // 优化后内容（序列化的 OptimizationResult JSON）
  optimizationScore Float?                        // AI 友好度评分（0-100）
  status            ContentStatus @default(DRAFT)
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  tasks             OptimizationTask[]

  @@unique([workspaceId, url])
  @@index([workspaceId, status])
}

enum ContentStatus {
  DRAFT
  REVIEWED
  PUBLISHED
}

model OptimizationTask {
  id           String     @id @default(cuid())
  workspaceId  String
  workspace    Workspace  @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  type         TaskType
  queryId      String?
  query        CitationQuery? @relation(fields: [queryId], references: [id])
  pageId       String?
  page         ContentPage?   @relation(fields: [pageId], references: [id])
  status       TaskStatus @default(PENDING)
  beforeScore  Float?
  afterScore   Float?
  result       Json?                        // OptimizationResult 摘要
  reviewNote   String?       @db.Text        // 审核反馈
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt

  @@index([workspaceId, status])
}

enum TaskType {
  OPTIMIZE_FOR_QUERY
  REWRITE_CONTENT
  GENERATE_SCHEMA
  UPDATE_KG
}

enum TaskStatus {
  PENDING
  IN_PROGRESS
  REVIEWED
  PUBLISHED
  FAILED
}
```

### 4.2 Workspace 模型更新

在现有 `Workspace` 模型中新增关联字段：

```prisma
  pages            ContentPage[]
  tasks            OptimizationTask[]
```

### 4.3 设计要点

- `optimizedContent` 存储序列化的 `OptimizationResult` JSON 字符串，便于审核时展示结构化结果
- `reviewNote` 审核反馈字段，拒绝时用于记录原因
- `OptimizationTask` 与 `CitationQuery` 可选关联：监测发现某 query 未引用品牌时，创建针对性优化任务
- `beforeScore` / `afterScore` 记录优化前后评分变化，用于效果验证

---

## 五、组件接口设计

### 5.1 ContentAtomizer

```typescript
// src/modules/content-optimizer/atomizer.ts

export interface AtomizerService {
  atomize(text: string): Promise<Atom[]>
}

export function createAtomizer(llm: LlmProvider): AtomizerService
```

**实现要点：**
- `temperature: 0`：结构化任务，不需要创造性
- Prompt 要求返回 JSON：`{ atoms: [{ text, subject, predicate, object, anchors, definition }] }`
- JSON 解析兜底：LLM 返回非 JSON 时，按段落分割 + 空字段处理（与 `query-library.ts` 的 `generateQueries` 兜底模式一致）

### 5.2 ScoringEngine

```typescript
// src/modules/content-optimizer/scoring.ts

export interface ScoringService {
  scoreAtoms(atoms: Atom[]): ScoredAtom[]
  scorePage(scored: ScoredAtom[]): number
}

export function createScoringEngine(): ScoringService
```

**实现要点（纯函数，零依赖）：**
- `hasNumericAnchor`：正则 `/\d+/`，匹配日期、百分比、货币、纯数字
- `hasEntityAnchor`：`anchors.some(a => isNaN(Number(a)))`
- `isSelfContained`：`subject && predicate && object` 三者都非空字符串
- `hasDefinition`：`definition` 字段非空

### 5.3 LlmRewriter

```typescript
// src/modules/content-optimizer/rewriter.ts

export interface RewriterService {
  rewrite(atom: Atom, score: AtomScore): Promise<Atom>
  rewriteBatch(atoms: ScoredAtom[], threshold?: number): Promise<ScoredAtom[]>
}

export function createRewriter(llm: LlmProvider): RewriterService
```

**实现要点：**
- `rewriteBatch` 筛选 `score.total < threshold`（默认 70）的 atoms，逐个重写
- 重写 Prompt 包含缺失维度提示（如"缺少数字锚点，请补充具体数字"）
- 重写后重新评分，更新 `ScoredAtom`

### 5.4 FaqGenerator

```typescript
// src/modules/content-optimizer/faq-generator.ts

export interface FaqGeneratorService {
  generate(input: GenerateFaqInput): Promise<FaqPair[]>
}

export interface GenerateFaqInput {
  atoms: Atom[]
  workspaceId?: string       // 用于查询 CitationQuery 库
  queries?: CitationQuery[]  // 或直接传入 query 列表
  count?: number             // 生成数量，默认 5
}

export function createFaqGenerator(
  llm: LlmProvider,
  prisma?: PrismaClient,
): FaqGeneratorService
```

**两种模式：**
1. **有 CitationQuery 库**：按 `workspaceId` 查 ACTIVE queries（或使用传入的 `queries`），传给 LLM 生成答案，标记 `source: 'citation_query'`
2. **无 query 库**：LLM 基于 atoms 自行生成 5W1H 问题，标记 `source: 'llm_generated'`

### 5.5 OptimizationTaskService

```typescript
// src/modules/content-optimizer/task-service.ts

export interface TaskService {
  create(input: CreateTaskInput): Promise<OptimizationTask>
  list(workspaceId: string, status?: TaskStatus): Promise<OptimizationTask[]>
  getById(id: string): Promise<OptimizationTask | null>
  review(id: string, approved: boolean, note?: string): Promise<OptimizationTask>
  publish(id: string): Promise<OptimizationTask>
}

export interface CreateTaskInput {
  workspaceId: string
  type: TaskType
  pageId?: string
  queryId?: string
  beforeScore?: number
  afterScore?: number
  result?: Record<string, unknown>
}

export function createTaskService(prisma: PrismaClient): TaskService
```

**review 方法逻辑：**
- `approved: true` → status 变为 `REVIEWED`，同时更新关联的 ContentPage.status 为 `REVIEWED`
- `approved: false` → status 变为 `PENDING`（退回重做），`reviewNote` 记录反馈

**publish 方法逻辑：**
- status 必须为 `REVIEWED` 才能发布
- 更新为 `PUBLISHED`，同时更新关联的 ContentPage.status 为 `PUBLISHED`

### 5.6 AtomizerOrchestrator

```typescript
// src/modules/content-optimizer/orchestrator.ts

export interface OptimizeInput {
  workspaceId: string
  content: string
  pageId?: string
  url?: string
  pageType?: string
}

export interface OrchestratorService {
  optimize(input: OptimizeInput): Promise<OptimizationResult>
}

export function createOrchestrator(deps: {
  atomizer: AtomizerService
  scoring: ScoringService
  rewriter: RewriterService
  faqGenerator: FaqGeneratorService
  taskService: TaskService
  prisma: PrismaClient
}): OrchestratorService
```

**编排流程：**
1. 如有 `pageId`，读取 ContentPage；否则用传入的 `content`
2. `atomizer.atomize(text)` → `Atom[]`
3. `scoring.scoreAtoms(atoms)` → `ScoredAtom[]`，记录 `beforeScore`（页面平均分）
4. `rewriter.rewriteBatch(scoredAtoms)` → 重写不达标的 atoms
5. 重新评分得到 `afterScore`
6. `faqGenerator.generate({ atoms, workspaceId })` → `FaqPair[]`
7. 组装 `OptimizationResult`
8. 更新 ContentPage（`optimizedContent` + `optimizationScore`）
9. `taskService.create(...)` 创建审核任务（status=PENDING）

---

## 六、tRPC 路由设计

### 6.1 contentRouter

```typescript
// src/modules/content-optimizer/router.ts

export const contentRouter = router({
  // 页面管理
  pages: router({
    upsert: protectedProcedure
      .input(z.object({
        url: z.string(),
        pageType: z.string(),
        currentContent: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        // 创建或更新 ContentPage
      }),

    list: protectedProcedure
      .input(z.object({
        status: z.enum(['draft', 'reviewed', 'published']).optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        // 按 workspace 查询页面列表
      }),

    get: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ ctx, input }) => {
        // 查询单个页面详情
      }),
  }),

  // 内容优化（触发完整流水线）
  optimize: protectedProcedure
    .input(z.object({
      pageId: z.string().optional(),
      content: z.string().optional(),
      url: z.string().optional(),
      pageType: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // 调 orchestrator.optimize()
    }),

  // 单独原子化
  atomize: protectedProcedure
    .input(z.object({ text: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // 调 atomizer.atomize()
    }),

  // 单独生成 FAQ
  generateFaq: protectedProcedure
    .input(z.object({
      topic: z.string(),
      count: z.number().min(1).max(20).default(5),
    }))
    .mutation(async ({ ctx, input }) => {
      // 调 faqGenerator.generate()
    }),
})
```

### 6.2 taskRouter

```typescript
// src/modules/content-optimizer/task-router.ts

export const taskRouter = router({
  list: protectedProcedure
    .input(z.object({
      status: z.enum(['pending', 'in_progress', 'reviewed', 'published', 'failed']).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      // 按 workspace 查询任务列表
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      // 查询单个任务详情
    }),

  review: protectedProcedure
    .input(z.object({
      id: z.string(),
      approved: z.boolean(),
      note: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // 调 taskService.review()
    }),

  publish: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // 调 taskService.publish()
    }),
})
```

### 6.3 总路由更新

```typescript
// src/router.ts
export const appRouter = router({
  workspace: workspaceRouter,
  citation: citationRouter,
  content: contentRouter,   // 新增
  tasks: taskRouter,        // 新增
})
```

### 6.4 server.ts 组装

在 `main()` 中组装 content-optimizer 组件并注入 services：

```typescript
const atomizer = createAtomizer(getLlmProvider())
const scoring = createScoringEngine()
const rewriter = createRewriter(getLlmProvider())
const faqGenerator = createFaqGenerator(getLlmProvider(), prisma)
const taskService = createTaskService(prisma)
const orchestrator = createOrchestrator({
  atomizer, scoring, rewriter, faqGenerator, taskService, prisma,
})

const services = {
  prisma, monitor, queryLibrary,
  orchestrator, taskService, atomizer, faqGenerator,
}
```

---

## 七、测试策略

### 7.1 测试分层

| 层级 | 测试对象 | Mock 策略 |
|------|---------|-----------|
| 纯逻辑 | ScoringEngine | 无需 mock |
| LLM 组件 | Atomizer / Rewriter / FaqGenerator | mock `LlmProvider` |
| 数据层 | TaskService | mock `PrismaClient` |
| 编排层 | Orchestrator | mock 全部子组件 |
| 路由层 | contentRouter / taskRouter | mock services |

### 7.2 测试文件清单

| 文件 | 测试重点 |
|------|---------|
| `scoring.test.ts` | 每个评分维度、边界值（满分/零分/刚好 70 分）、页面整体评分 |
| `atomizer.test.ts` | LLM 正常 JSON 解析、非 JSON 兜底、空内容处理 |
| `rewriter.test.ts` | 批量筛选不达标 atom、重写后重新评分、threshold 参数 |
| `faq-generator.test.ts` | CitationQuery 库模式、LLM 独立生成模式、count 参数 |
| `task-service.test.ts` | CRUD、review 状态流转（approve/reject）、publish 前置条件 |
| `orchestrator.test.ts` | 流水线顺序、全达标不重写、部分重写、结果组装 |
| `router.test.ts` | 输入校验、workspace 隔离、optimize/atomize/generateFaq |
| `task-router.test.ts` | 任务列表、review、publish 路由 |

### 7.3 关键测试用例

**ScoringEngine：**
- 满分 atom（4 维度全命中 → 100 分）
- 零分 atom（全空 → 0 分）
- 仅数字锚点（35 分，不达标）
- 数字 + 实体锚点 + 自解释（85 分，达标）
- 最接近阈值边界：75 分（数字 35 + 自解释 25 + 定义 15 = 75，达标）和 60 分（数字 35 + 自解释 25 = 60，不达标）

**Atomizer：**
- LLM 返回合法 JSON → 正确解析为 `Atom[]`
- LLM 返回纯文本（非 JSON）→ 按段落兜底分割
- 空内容输入 → 返回空数组

**Orchestrator：**
- 所有 atom 达标 → 不触发 rewriter
- 部分 atom 不达标 → 触发 rewriter，重写后重新评分
- FaqGenerator 收到重写后的 atoms（非原始 atoms）

---

## 八、文件结构

```
src/modules/content-optimizer/
├── atomizer.ts            # ContentAtomizer
├── atomizer.test.ts
├── scoring.ts             # ScoringEngine
├── scoring.test.ts
├── rewriter.ts            # LlmRewriter
├── rewriter.test.ts
├── faq-generator.ts       # FaqGenerator
├── faq-generator.test.ts
├── task-service.ts        # OptimizationTaskService
├── task-service.test.ts
├── orchestrator.ts        # AtomizerOrchestrator（流水线编排）
├── orchestrator.test.ts
├── types.ts               # Atom / ScoredAtom / FaqPair / OptimizationResult
├── router.ts              # contentRouter
├── router.test.ts
├── task-router.ts         # taskRouter
└── task-router.test.ts
```

---

## 自检

1. **占位符扫描：** 无 TODO / 待定 / 未完成章节。所有接口和方法签名都已明确。
2. **内部一致性：**
   - 数据结构（第三章）与组件接口（第五章）完全对应
   - 数据库模型（第四章）与 tRPC 路由（第六章）字段一致
   - 评分规则（第三章）与测试用例（第七章）覆盖的边界值匹配
3. **范围检查：** 本设计聚焦阶段 2 的 6 个子任务，不含 webhook（阶段 4）、Schema 生成（阶段 3）、知识图谱（阶段 3）。可用一个实现计划覆盖。
4. **模糊性检查：**
   - FAQ 双模式：明确了优先级（CitationQuery 库优先，回退 LLM 生成）
   - review 行为：approve/reject 的状态流转已明确
   - 评分阈值：明确为 70 分，权重明确（35/25/25/15）
