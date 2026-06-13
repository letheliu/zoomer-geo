# Content Optimizer 阶段 2 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 Content Optimizer 模块，把普通内容改写成 AI 友好形态，提升被 AI 引用的概率。

**架构：** 分步流水线——ContentAtomizer（LLM 语义切分）→ ScoringEngine（纯规则评分）→ LlmRewriter（不达标段落重写）→ FaqGenerator（问答对生成）。每个组件是工厂函数 + 依赖注入，与阶段 1 代码模式一致。Orchestrator 编排完整流水线，OptimizationTaskService 管理审核状态机。

**技术栈：** TypeScript / Node.js、tRPC 10、Prisma 5、Vitest。复用阶段 1 的 LlmProvider 抽象层和 PrismaClient。

**规格依据：** `docs/superpowers/specs/2026-06-13-content-optimizer-phase2-design.md`

**范围边界（本计划不包含）：** Schema Generator、Knowledge Graph、webhook 通知、完整闭环验证——这些属于阶段 3/4。

---

## 文件结构

```
src/modules/content-optimizer/
├── types.ts               # Atom / ScoredAtom / FaqPair / OptimizationResult 类型定义
├── scoring.ts             # ScoringEngine（纯规则评分）
├── scoring.test.ts        # 评分维度、边界值测试
├── atomizer.ts            # ContentAtomizer（LLM 语义切分）
├── atomizer.test.ts       # LLM mock、JSON 解析、兜底测试
├── rewriter.ts            # LlmRewriter（不达标段落重写）
├── rewriter.test.ts       # 批量筛选、重写后评分测试
├── faq-generator.ts       # FaqGenerator（双模式 FAQ 生成）
├── faq-generator.test.ts  # CitationQuery 库模式、LLM 独立模式测试
├── task-service.ts        # OptimizationTaskService（CRUD + 审核状态机）
├── task-service.test.ts   # 状态流转、review/publish 测试
├── orchestrator.ts        # AtomizerOrchestrator（流水线编排）
├── orchestrator.test.ts   # 全流程编排、部分重写测试
├── router.ts              # contentRouter（页面管理 + 优化 + 原子化 + FAQ）
├── router.test.ts         # 路由输入校验、workspace 隔离测试
├── task-router.ts         # taskRouter（任务列表 + 审核 + 发布）
└── task-router.test.ts    # 任务路由测试
```

修改的现有文件：
- `prisma/schema.prisma` — 新增 ContentPage / OptimizationTask 模型 + Workspace 关联
- `src/router.ts` — 注册 contentRouter 和 taskRouter
- `src/server.ts` — 组装 content-optimizer 组件并注入 services

---

## 任务 1：Prisma Schema 变更

**文件：**
- 修改：`prisma/schema.prisma`

- [ ] **步骤 1：在 Workspace 模型中添加关联**

在 `prisma/schema.prisma` 的 `Workspace` 模型的 `events CitationEvent[]` 之后添加：

```prisma
  pages            ContentPage[]
  tasks            OptimizationTask[]
```

- [ ] **步骤 2：在文件末尾添加 ContentPage 模型**

在 `prisma/schema.prisma` 的 `CitationEvent` 模型之后添加：

```prisma
// ============ 模块 2：内容优化 ============

model ContentPage {
  id                String        @id @default(cuid())
  workspaceId       String
  workspace         Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  url               String
  pageType          String
  currentContent    String        @db.Text
  optimizedContent  String?       @db.Text
  optimizationScore Float?
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
```

- [ ] **步骤 3：添加 OptimizationTask 模型**

在 ContentPage 模型之后添加：

```prisma
model OptimizationTask {
  id           String      @id @default(cuid())
  workspaceId  String
  workspace    Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  type         TaskType
  queryId      String?
  query        CitationQuery? @relation(fields: [queryId], references: [id])
  pageId       String?
  page         ContentPage?   @relation(fields: [pageId], references: [id])
  status       TaskStatus  @default(PENDING)
  beforeScore  Float?
  afterScore   Float?
  result       Json?
  reviewNote   String?     @db.Text
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

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

- [ ] **步骤 4：生成 Prisma Client 并验证**

运行：`npx prisma generate`
预期：输出 "Generated Prisma Client"，无错误。

- [ ] **步骤 5：Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): add ContentPage and OptimizationTask models for phase 2"
```

---

## 任务 2：类型定义

**文件：**
- 创建：`src/modules/content-optimizer/types.ts`

- [ ] **步骤 1：创建类型文件**

创建 `src/modules/content-optimizer/types.ts`：

```typescript
/** 内容原子单元 */
export interface Atom {
  text: string
  subject: string
  predicate: string
  object: string
  anchors: string[]
  definition?: string
}

/** 原子评分明细 */
export interface AtomScore {
  total: number
  hasNumericAnchor: boolean
  hasEntityAnchor: boolean
  isSelfContained: boolean
  hasDefinition: boolean
}

/** 评分后的原子单元 */
export interface ScoredAtom extends Atom {
  score: AtomScore
}

/** 问答对 */
export interface FaqPair {
  question: string
  answer: string
  matchedQueryId?: string
  source: 'citation_query' | 'llm_generated'
}

/** 优化报告指标 */
export interface OptimizationReport {
  atomizationRate: number
  independenceRate: number
  faqCoverage: number
}

/** 流水线最终输出 */
export interface OptimizationResult {
  atoms: ScoredAtom[]
  faqs: FaqPair[]
  overallScore: number
  rewrittenCount: number
  report: OptimizationReport
}
```

- [ ] **步骤 2：验证编译**

运行：`npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add src/modules/content-optimizer/types.ts
git commit -m "feat(content-optimizer): add core type definitions"
```

---

## 任务 3：ScoringEngine（纯规则评分）

**文件：**
- 创建：`src/modules/content-optimizer/scoring.ts`
- 测试：`src/modules/content-optimizer/scoring.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/content-optimizer/scoring.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { createScoringEngine } from './scoring.js'
import type { Atom } from './types.js'

describe('ScoringEngine', () => {
  const scoring = createScoringEngine()

  const fullAtom: Atom = {
    text: 'zoomer AI 在 2024 年获得了 50 万用户',
    subject: 'zoomer AI',
    predicate: '获得了',
    object: '50 万用户',
    anchors: ['2024年', '50万', 'zoomer AI'],
    definition: 'zoomer AI 是一款 AI 设计工具',
  }

  it('满分 atom（4 维度全命中 → 100 分）', () => {
    const [scored] = scoring.scoreAtoms([fullAtom])
    expect(scored.score.total).toBe(100)
    expect(scored.score.hasNumericAnchor).toBe(true)
    expect(scored.score.hasEntityAnchor).toBe(true)
    expect(scored.score.isSelfContained).toBe(true)
    expect(scored.score.hasDefinition).toBe(true)
  })

  it('零分 atom（全空 → 0 分）', () => {
    const emptyAtom: Atom = {
      text: '内容很好',
      subject: '',
      predicate: '',
      object: '',
      anchors: [],
    }
    const [scored] = scoring.scoreAtoms([emptyAtom])
    expect(scored.score.total).toBe(0)
    expect(scored.score.hasNumericAnchor).toBe(false)
    expect(scored.score.hasEntityAnchor).toBe(false)
    expect(scored.score.isSelfContained).toBe(false)
    expect(scored.score.hasDefinition).toBe(false)
  })

  it('仅数字锚点（35 分，不达标）', () => {
    const atom: Atom = {
      text: '有 100 个',
      subject: '',
      predicate: '',
      object: '',
      anchors: ['100'],
    }
    const [scored] = scoring.scoreAtoms([atom])
    expect(scored.score.total).toBe(35)
    expect(scored.score.hasNumericAnchor).toBe(true)
    expect(scored.score.hasEntityAnchor).toBe(false)
  })

  it('数字 + 实体锚点 + 自解释（85 分，达标）', () => {
    const atom: Atom = {
      text: 'zoomer AI 在 2024 年获得了用户',
      subject: 'zoomer AI',
      predicate: '获得了',
      object: '用户',
      anchors: ['2024年', 'zoomer AI'],
    }
    const [scored] = scoring.scoreAtoms([atom])
    expect(scored.score.total).toBe(85)
  })

  it('最接近阈值边界：75 分达标', () => {
    const atom: Atom = {
      text: 'zoomer AI 是工具，2024 年发布',
      subject: 'zoomer AI',
      predicate: '发布',
      object: '工具',
      anchors: ['2024'],
      definition: 'zoomer AI 是一款工具',
    }
    // 数字 35 + 自解释 25 + 定义 15 = 75，无实体锚点
    const [scored] = scoring.scoreAtoms([atom])
    expect(scored.score.total).toBe(75)
    expect(scored.score.hasEntityAnchor).toBe(false)
  })

  it('最接近阈值边界：60 分不达标', () => {
    const atom: Atom = {
      text: 'zoomer AI 有 100 用户',
      subject: 'zoomer AI',
      predicate: '有',
      object: '用户',
      anchors: ['100'],
    }
    // 数字 35 + 自解释 25 = 60
    const [scored] = scoring.scoreAtoms([atom])
    expect(scored.score.total).toBe(60)
  })

  it('scorePage 计算所有 atom 的平均分', () => {
    const atoms: Atom[] = [
      { ...fullAtom, anchors: ['2024', 'zoomer AI'], definition: 'def' },
      { text: 'x', subject: '', predicate: '', object: '', anchors: [] },
    ]
    const scored = scoring.scoreAtoms(atoms)
    const pageScore = scoring.scorePage(scored)
    // 第一个 100 分，第二个 0 分，平均 50
    expect(pageScore).toBe(50)
  })

  it('空数组评分返回 0', () => {
    expect(scoring.scorePage(scoring.scoreAtoms([]))).toBe(0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/content-optimizer/scoring.test.ts`
预期：FAIL，报错 `createScoringEngine is not a function` 或模块找不到。

- [ ] **步骤 3：编写实现**

创建 `src/modules/content-optimizer/scoring.ts`：

```typescript
import type { Atom, ScoredAtom, AtomScore } from './types.js'

const WEIGHTS = {
  numericAnchor: 35,
  entityAnchor: 25,
  selfContained: 25,
  definition: 15,
} as const

const THRESHOLD = 70

const NUMERIC_REGEX = /\d/

function hasNumericAnchor(atom: Atom): boolean {
  if (NUMERIC_REGEX.test(atom.text)) return true
  return atom.anchors.some((a) => NUMERIC_REGEX.test(a))
}

function hasEntityAnchor(atom: Atom): boolean {
  return atom.anchors.some((a) => !NUMERIC_REGEX.test(a))
}

function isSelfContained(atom: Atom): boolean {
  return !!(atom.subject && atom.predicate && atom.object)
}

function hasDefinition(atom: Atom): boolean {
  return !!atom.definition
}

function scoreAtom(atom: Atom): AtomScore {
  const hasNum = hasNumericAnchor(atom)
  const hasEnt = hasEntityAnchor(atom)
  const selfContained = isSelfContained(atom)
  const hasDef = hasDefinition(atom)

  const total =
    (hasNum ? WEIGHTS.numericAnchor : 0) +
    (hasEnt ? WEIGHTS.entityAnchor : 0) +
    (selfContained ? WEIGHTS.selfContained : 0) +
    (hasDef ? WEIGHTS.definition : 0)

  return {
    total,
    hasNumericAnchor: hasNum,
    hasEntityAnchor: hasEnt,
    isSelfContained: selfContained,
    hasDefinition: hasDef,
  }
}

export interface ScoringService {
  scoreAtoms(atoms: Atom[]): ScoredAtom[]
  scorePage(scored: ScoredAtom[]): number
}

export function createScoringEngine(): ScoringService {
  return {
    scoreAtoms(atoms) {
      return atoms.map((atom) => ({ ...atom, score: scoreAtom(atom) }))
    },

    scorePage(scored) {
      if (scored.length === 0) return 0
      const sum = scored.reduce((acc, a) => acc + a.score.total, 0)
      return Math.round(sum / scored.length)
    },
  }
}

export { THRESHOLD }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/content-optimizer/scoring.test.ts`
预期：PASS，所有测试通过。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/content-optimizer/scoring.ts src/modules/content-optimizer/scoring.test.ts
git commit -m "feat(content-optimizer): add ScoringEngine with rule-based scoring"
```

---

## 任务 4：ContentAtomizer（LLM 语义切分）

**文件：**
- 创建：`src/modules/content-optimizer/atomizer.ts`
- 测试：`src/modules/content-optimizer/atomizer.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/content-optimizer/atomizer.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createAtomizer } from './atomizer.js'
import type { LlmProvider } from '../../core/llm/types.js'

function mockLlm(responseText: string): LlmProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseText }),
    embed: vi.fn(),
  }
}

describe('ContentAtomizer', () => {
  it('解析 LLM 返回的合法 JSON', async () => {
    const llmResponse = JSON.stringify({
      atoms: [
        {
          text: 'zoomer AI 在 2024 年获得了 50 万用户',
          subject: 'zoomer AI',
          predicate: '获得了',
          object: '50 万用户',
          anchors: ['2024年', '50万'],
          definition: 'zoomer AI 是一款 AI 设计工具',
        },
      ],
    })
    const atomizer = createAtomizer(mockLlm(llmResponse))
    const atoms = await atomizer.atomize('原始内容')
    expect(atoms).toHaveLength(1)
    expect(atoms[0].subject).toBe('zoomer AI')
    expect(atoms[0].anchors).toContain('2024年')
  })

  it('LLM 返回非 JSON 时兜底按段落分割', async () => {
    const llmResponse = '这是第一段。\n\n这是第二段。'
    const atomizer = createAtomizer(mockLlm(llmResponse))
    const atoms = await atomizer.atomize('原始内容')
    expect(atoms).toHaveLength(2)
    expect(atoms[0].text).toBe('这是第一段。')
    expect(atoms[0].subject).toBe('')
    expect(atoms[1].text).toBe('这是第二段。')
  })

  it('空内容返回空数组', async () => {
    const atomizer = createAtomizer(mockLlm(JSON.stringify({ atoms: [] })))
    const atoms = await atomizer.atomize('')
    expect(atoms).toHaveLength(0)
  })

  it('使用 temperature: 0 调用 LLM', async () => {
    const llm = mockLlm(JSON.stringify({ atoms: [] }))
    const atomizer = createAtomizer(llm)
    await atomizer.atomize('test')
    expect(llm.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ temperature: 0 }),
    )
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/content-optimizer/atomizer.test.ts`
预期：FAIL，模块找不到。

- [ ] **步骤 3：编写实现**

创建 `src/modules/content-optimizer/atomizer.ts`：

```typescript
import type { LlmProvider } from '../../core/llm/types.js'
import type { Atom } from './types.js'

const SYSTEM_PROMPT = `你是一个 GEO 优化专家。把用户提供的内容做语义切分（原子化），每段提取以下字段：
- text: 段落原文
- subject: 这段在说谁（实体名）
- predicate: 说了什么（动词短语）
- object: 对象
- anchors: 数据锚点数组（具体数字、时间、机构名）
- definition: 定义句（"X 是 Y" 格式），可选

要求：
1. 每段必须含具体数字、时间或机构名
2. 把形容词替换为可验证的事实
3. 在开头给出定义句

只输出 JSON，格式：{ "atoms": [{ "text": "...", "subject": "...", "predicate": "...", "object": "...", "anchors": ["..."], "definition": "..." }] }`

export interface AtomizerService {
  atomize(text: string): Promise<Atom[]>
}

export function createAtomizer(llm: LlmProvider): AtomizerService {
  return {
    async atomize(text) {
      if (!text || text.trim().length === 0) return []

      const res = await llm.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        { temperature: 0 },
      )

      return parseAtoms(res.text)
    },
  }
}

function parseAtoms(raw: string): Atom[] {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.atoms)) {
      return parsed.atoms.map((a: any) => ({
        text: String(a.text || ''),
        subject: String(a.subject || ''),
        predicate: String(a.predicate || ''),
        object: String(a.object || ''),
        anchors: Array.isArray(a.anchors) ? a.anchors.map(String) : [],
        definition: a.definition ? String(a.definition) : undefined,
      }))
    }
  } catch {
    // JSON 解析失败，兜底
  }

  // 兜底：按双换行分段
  return raw
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({
      text,
      subject: '',
      predicate: '',
      object: '',
      anchors: [],
    }))
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/content-optimizer/atomizer.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/content-optimizer/atomizer.ts src/modules/content-optimizer/atomizer.test.ts
git commit -m "feat(content-optimizer): add ContentAtomizer with LLM semantic segmentation"
```

---

## 任务 5：LlmRewriter（不达标段落重写）

**文件：**
- 创建：`src/modules/content-optimizer/rewriter.ts`
- 测试：`src/modules/content-optimizer/rewriter.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/content-optimizer/rewriter.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createRewriter } from './rewriter.js'
import type { LlmProvider } from '../../core/llm/types.js'
import type { ScoredAtom } from './types.js'

function mockLlm(responseText: string): LlmProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseText }),
    embed: vi.fn(),
  }
}

function makeScoredAtom(overrides: Partial<ScoredAtom> = {}): ScoredAtom {
  return {
    text: '原始文本',
    subject: 'zoomer AI',
    predicate: '是',
    object: '工具',
    anchors: [],
    score: {
      total: 40,
      hasNumericAnchor: false,
      hasEntityAnchor: false,
      isSelfContained: true,
      hasDefinition: false,
    },
    ...overrides,
  }
}

describe('LlmRewriter', () => {
  it('rewriteBatch 只重写不达标的 atom（score < threshold）', async () => {
    const rewrittenJson = JSON.stringify({
      text: 'zoomer AI 在 2024 年服务了 50 万设计师',
      subject: 'zoomer AI',
      predicate: '服务了',
      object: '50 万设计师',
      anchors: ['2024年', '50万', 'zoomer AI'],
      definition: 'zoomer AI 是一款 AI 设计工具',
    })
    const llm = mockLlm(rewrittenJson)
    const rewriter = createRewriter(llm)

    const lowScoreAtom = makeScoredAtom({
      text: 'a',
      score: { total: 40, hasNumericAnchor: false, hasEntityAnchor: false, isSelfContained: true, hasDefinition: false },
    })
    const highScoreAtom = makeScoredAtom({
      text: 'b',
      score: { total: 85, hasNumericAnchor: true, hasEntityAnchor: true, isSelfContained: true, hasDefinition: false },
    })

    const result = await rewriter.rewriteBatch([lowScoreAtom, highScoreAtom])
    expect(result).toHaveLength(2)

    // 低分的被重写了
    const rewritten = result.find((a) => a.text.includes('50 万设计师'))
    expect(rewritten).toBeDefined()
    expect(rewritten!.score.total).toBeGreaterThanOrEqual(70)

    // 高分的保持不变
    const unchanged = result.find((a) => a.text === 'b')
    expect(unchanged).toBeDefined()
    expect(unchanged!.score.total).toBe(85)
  })

  it('默认 threshold 为 70', async () => {
    const llm = mockLlm(JSON.stringify({
      text: '改写后',
      subject: 'x',
      predicate: 'y',
      object: 'z',
      anchors: ['123'],
      definition: 'x 是 z',
    }))
    const rewriter = createRewriter(llm)

    const atom = makeScoredAtom({
      score: { total: 69, hasNumericAnchor: false, hasEntityAnchor: false, isSelfContained: true, hasDefinition: false },
    })
    await rewriter.rewriteBatch([atom])
    expect(llm.chat).toHaveBeenCalled()
  })

  it('score 等于 threshold 时不重写', async () => {
    const llm = mockLlm('{}')
    const rewriter = createRewriter(llm)

    const atom = makeScoredAtom({
      score: { total: 70, hasNumericAnchor: true, hasEntityAnchor: true, isSelfContained: true, hasDefinition: false },
    })
    await rewriter.rewriteBatch([atom])
    expect(llm.chat).not.toHaveBeenCalled()
  })

  it('rewrite 单个 atom', async () => {
    const rewrittenJson = JSON.stringify({
      text: '改写后内容 2024',
      subject: 'zoomer AI',
      predicate: '是',
      object: '工具',
      anchors: ['2024', 'zoomer AI'],
      definition: 'zoomer AI 是工具',
    })
    const llm = mockLlm(rewrittenJson)
    const rewriter = createRewriter(llm)

    const atom = makeScoredAtom()
    const result = await rewriter.rewrite(atom, atom.score)
    expect(result.text).toBe('改写后内容 2024')
    expect(result.anchors).toContain('2024')
  })

  it('LLM 返回非 JSON 时保留原文', async () => {
    const llm = mockLlm('这不是JSON')
    const rewriter = createRewriter(llm)

    const atom = makeScoredAtom({ text: '原始' })
    const result = await rewriter.rewrite(atom, atom.score)
    expect(result.text).toBe('原始')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/content-optimizer/rewriter.test.ts`
预期：FAIL，模块找不到。

- [ ] **步骤 3：编写实现**

创建 `src/modules/content-optimizer/rewriter.ts`：

```typescript
import type { LlmProvider } from '../../core/llm/types.js'
import type { Atom, ScoredAtom, AtomScore } from './types.js'
import { createScoringEngine } from './scoring.js'

const SYSTEM_PROMPT = `你是一个 GEO 优化专家。重写以下内容段落，使其更易被 AI 搜索引擎引用。

改进方向（根据缺失维度补充）：
1. 补充具体数字、时间、统计数据
2. 补充机构名、专有名词等实体锚点
3. 确保段落可以独立理解（包含明确的主语）
4. 在开头添加定义句（"X 是 Y" 格式）

只输出 JSON：{ "text": "...", "subject": "...", "predicate": "...", "object": "...", "anchors": ["..."], "definition": "..." }`

function buildUserPrompt(atom: Atom, score: AtomScore): string {
  const missing: string[] = []
  if (!score.hasNumericAnchor) missing.push('数字/时间锚点')
  if (!score.hasEntityAnchor) missing.push('实体锚点（机构名/专有名词）')
  if (!score.isSelfContained) missing.push('独立可理解性（主语/谓语/宾语）')
  if (!score.hasDefinition) missing.push('定义句')

  return `原文：${atom.text}

当前缺失：${missing.join('、') || '无'}
请重写这段内容，补全缺失的维度。`
}

function parseRewritten(raw: string): Partial<Atom> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.text === 'string') {
      return {
        text: String(parsed.text),
        subject: String(parsed.subject || ''),
        predicate: String(parsed.predicate || ''),
        object: String(parsed.object || ''),
        anchors: Array.isArray(parsed.anchors) ? parsed.anchors.map(String) : [],
        definition: parsed.definition ? String(parsed.definition) : undefined,
      }
    }
  } catch {
    // 兜底
  }
  return null
}

export interface RewriterService {
  rewrite(atom: Atom, score: AtomScore): Promise<Atom>
  rewriteBatch(atoms: ScoredAtom[], threshold?: number): Promise<ScoredAtom[]>
}

export function createRewriter(llm: LlmProvider): RewriterService {
  const scoring = createScoringEngine()

  return {
    async rewrite(atom, score) {
      const res = await llm.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(atom, score) },
        ],
        { temperature: 0.3 },
      )
      const rewritten = parseRewritten(res.text)
      return rewritten ?? atom
    },

    async rewriteBatch(atoms, threshold = 70) {
      const results: ScoredAtom[] = []

      for (const atom of atoms) {
        if (atom.score.total >= threshold) {
          results.push(atom)
          continue
        }

        const rewritten = await this.rewrite(atom, atom.score)
        // 重新评分
        const [rescored] = scoring.scoreAtoms([rewritten])
        results.push(rescored)
      }

      return results
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/content-optimizer/rewriter.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/content-optimizer/rewriter.ts src/modules/content-optimizer/rewriter.test.ts
git commit -m "feat(content-optimizer): add LlmRewriter for sub-threshold atom rewriting"
```

---

## 任务 6：FaqGenerator（双模式 FAQ 生成）

**文件：**
- 创建：`src/modules/content-optimizer/faq-generator.ts`
- 测试：`src/modules/content-optimizer/faq-generator.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/content-optimizer/faq-generator.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createFaqGenerator } from './faq-generator.js'
import type { LlmProvider } from '../../core/llm/types.js'
import type { Atom } from './types.js'

function mockLlm(responseText: string): LlmProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseText }),
    embed: vi.fn(),
  }
}

function mockPrisma(queryResult: any[] = []) {
  return {
    citationQuery: {
      findMany: vi.fn().mockResolvedValue(queryResult),
    },
  } as any
}

const sampleAtoms: Atom[] = [
  {
    text: 'zoomer AI 是一款 AI 设计工具',
    subject: 'zoomer AI',
    predicate: '是',
    object: 'AI 设计工具',
    anchors: ['zoomer AI'],
    definition: 'zoomer AI 是一款 AI 设计工具',
  },
]

describe('FaqGenerator', () => {
  it('有 CitationQuery 库时，基于真实 query 生成 FAQ', async () => {
    const queries = [
      { id: 'q1', queryText: 'AI设计工具哪个好' },
      { id: 'q2', queryText: 'zoomer AI 怎么样' },
    ]
    const faqJson = JSON.stringify({
      faqs: [
        { question: 'AI设计工具哪个好？', answer: 'zoomer AI 是一款优秀的 AI 设计工具', matchedQueryId: 'q1' },
        { question: 'zoomer AI 怎么样？', answer: 'zoomer AI 功能强大', matchedQueryId: 'q2' },
      ],
    })
    const llm = mockLlm(faqJson)
    const prisma = mockPrisma(queries)
    const generator = createFaqGenerator(llm, prisma)

    const faqs = await generator.generate({ atoms: sampleAtoms, workspaceId: 'w1', count: 2 })

    expect(faqs).toHaveLength(2)
    expect(faqs[0].source).toBe('citation_query')
    expect(faqs[0].matchedQueryId).toBe('q1')
    expect(prisma.citationQuery.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'ACTIVE' },
    })
  })

  it('传入 queries 参数时直接使用，不查数据库', async () => {
    const queries = [{ id: 'q1', queryText: '什么是 zoomer AI' }]
    const faqJson = JSON.stringify({
      faqs: [
        { question: '什么是 zoomer AI？', answer: 'zoomer AI 是设计工具', matchedQueryId: 'q1' },
      ],
    })
    const llm = mockLlm(faqJson)
    const prisma = mockPrisma()
    const generator = createFaqGenerator(llm, prisma)

    const faqs = await generator.generate({ atoms: sampleAtoms, queries: queries as any })

    expect(faqs).toHaveLength(1)
    expect(prisma.citationQuery.findMany).not.toHaveBeenCalled()
  })

  it('无 query 库时，LLM 独立生成 5W1H 问题', async () => {
    const faqJson = JSON.stringify({
      faqs: [
        { question: '什么是 zoomer AI？', answer: 'zoomer AI 是一款 AI 设计工具' },
        { question: '谁适合使用 zoomer AI？', answer: '设计师' },
      ],
    })
    const llm = mockLlm(faqJson)
    const generator = createFaqGenerator(llm)

    const faqs = await generator.generate({ atoms: sampleAtoms })

    expect(faqs).toHaveLength(2)
    expect(faqs[0].source).toBe('llm_generated')
    expect(faqs[0].matchedQueryId).toBeUndefined()
  })

  it('无 query 且无 prisma 时 LLM 独立生成', async () => {
    const faqJson = JSON.stringify({
      faqs: [{ question: 'Q?', answer: 'A' }],
    })
    const llm = mockLlm(faqJson)
    const generator = createFaqGenerator(llm)

    const faqs = await generator.generate({ atoms: sampleAtoms, count: 1 })

    expect(faqs).toHaveLength(1)
    expect(faqs[0].source).toBe('llm_generated')
  })

  it('LLM 返回非 JSON 时返回空数组', async () => {
    const llm = mockLlm('不是 JSON')
    const generator = createFaqGenerator(llm)

    const faqs = await generator.generate({ atoms: sampleAtoms })
    expect(faqs).toHaveLength(0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/content-optimizer/faq-generator.test.ts`
预期：FAIL，模块找不到。

- [ ] **步骤 3：编写实现**

创建 `src/modules/content-optimizer/faq-generator.ts`：

```typescript
import type { PrismaClient } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'
import type { Atom, FaqPair } from './types.js'

export interface GenerateFaqInput {
  atoms: Atom[]
  workspaceId?: string
  queries?: Array<{ id: string; queryText: string }>
  count?: number
}

export interface FaqGeneratorService {
  generate(input: GenerateFaqInput): Promise<FaqPair[]>
}

export function createFaqGenerator(
  llm: LlmProvider,
  prisma?: PrismaClient,
): FaqGeneratorService {
  return {
    async generate(input) {
      const count = input.count ?? 5

      // 确定是否有 query 来源
      let queries: Array<{ id: string; queryText: string }> | undefined

      if (input.queries && input.queries.length > 0) {
        queries = input.queries
      } else if (prisma && input.workspaceId) {
        queries = await prisma.citationQuery.findMany({
          where: { workspaceId: input.workspaceId, status: 'ACTIVE' },
        })
      }

      const hasQueries = queries && queries.length > 0

      if (hasQueries) {
        return generateFromQueries(llm, input.atoms, queries!, count)
      }
      return generateFromAtoms(llm, input.atoms, count)
    },
  }
}

async function generateFromQueries(
  llm: LlmProvider,
  atoms: Atom[],
  queries: Array<{ id: string; queryText: string }>,
  count: number,
): Promise<FaqPair[]> {
  const selectedQueries = queries.slice(0, count)
  const contentContext = atoms.map((a) => a.text).join('\n')

  const prompt = `基于以下内容和用户高频问题，生成问答对。

内容：
${contentContext}

用户问题：
${selectedQueries.map((q, i) => `${i + 1}. ${q.queryText}`).join('\n')}

为每个问题生成简洁准确的答案。只输出 JSON：{ "faqs": [{ "question": "...", "answer": "...", "matchedQueryId": "..." }] }`

  const res = await llm.chat(
    [{ role: 'user', content: prompt }],
    { temperature: 0.3 },
  )

  return parseFaqs(res.text, 'citation_query')
}

async function generateFromAtoms(
  llm: LlmProvider,
  atoms: Atom[],
  count: number,
): Promise<FaqPair[]> {
  const contentContext = atoms.map((a) => a.text).join('\n')

  const prompt = `基于以下内容，从 5W1H（What/Who/When/Where/Why/How）角度生成 ${count} 个问答对。

内容：
${contentContext}

只输出 JSON：{ "faqs": [{ "question": "...", "answer": "..." }] }`

  const res = await llm.chat(
    [{ role: 'user', content: prompt }],
    { temperature: 0.5 },
  )

  return parseFaqs(res.text, 'llm_generated')
}

function parseFaqs(
  raw: string,
  source: 'citation_query' | 'llm_generated',
): FaqPair[] {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.faqs)) {
      return parsed.faqs.map((f: any) => ({
        question: String(f.question || ''),
        answer: String(f.answer || ''),
        matchedQueryId: f.matchedQueryId ? String(f.matchedQueryId) : undefined,
        source,
      }))
    }
  } catch {
    // 兜底
  }
  return []
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/content-optimizer/faq-generator.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/content-optimizer/faq-generator.ts src/modules/content-optimizer/faq-generator.test.ts
git commit -m "feat(content-optimizer): add FaqGenerator with dual-mode query sourcing"
```

---

## 任务 7：OptimizationTaskService（CRUD + 审核状态机）

**文件：**
- 创建：`src/modules/content-optimizer/task-service.ts`
- 测试：`src/modules/content-optimizer/task-service.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/content-optimizer/task-service.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTaskService } from './task-service.js'

function mockPrisma() {
  return {
    optimizationTask: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'task-1',
        ...args.data,
      })),
      findMany: vi.fn().mockResolvedValue([
        { id: 'task-1', status: 'PENDING', workspaceId: 'w1' },
      ]),
      findUnique: vi.fn().mockImplementation(async (args: any) => ({
        id: args.where.id,
        status: 'PENDING',
        workspaceId: 'w1',
        pageId: 'page-1',
      })),
      update: vi.fn().mockImplementation(async (args: any) => ({
        id: args.where.id,
        ...args.data,
      })),
    },
    contentPage: {
      update: vi.fn().mockResolvedValue({}),
    },
  } as any
}

describe('OptimizationTaskService', () => {
  let prisma: ReturnType<typeof mockPrisma>

  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('create 创建任务', async () => {
    const svc = createTaskService(prisma)
    const task = await svc.create({
      workspaceId: 'w1',
      type: 'REWRITE_CONTENT',
      pageId: 'page-1',
      beforeScore: 40,
      afterScore: 85,
    })
    expect(task.id).toBe('task-1')
    expect(prisma.optimizationTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'w1',
        type: 'REWRITE_CONTENT',
        status: 'PENDING',
      }),
    })
  })

  it('list 按 workspace 查询任务', async () => {
    const svc = createTaskService(prisma)
    const tasks = await svc.list('w1')
    expect(tasks).toHaveLength(1)
    expect(prisma.optimizationTask.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1' },
    })
  })

  it('list 按 workspace + status 过滤', async () => {
    const svc = createTaskService(prisma)
    await svc.list('w1', 'PENDING')
    expect(prisma.optimizationTask.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'PENDING' },
    })
  })

  it('getById 查询单个任务', async () => {
    const svc = createTaskService(prisma)
    const task = await svc.getById('task-1')
    expect(task?.id).toBe('task-1')
  })

  it('review approve 时 status 变为 REVIEWED，同时更新 ContentPage', async () => {
    const svc = createTaskService(prisma)
    const task = await svc.review('task-1', true)
    expect(task.status).toBe('REVIEWED')
    expect(prisma.optimizationTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'REVIEWED' },
    })
    expect(prisma.contentPage.update).toHaveBeenCalled()
  })

  it('review reject 时 status 退回 PENDING 并记录 reviewNote', async () => {
    const svc = createTaskService(prisma)
    const task = await svc.review('task-1', false, '内容不准确')
    expect(task.status).toBe('PENDING')
    expect(prisma.optimizationTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'PENDING', reviewNote: '内容不准确' },
    })
  })

  it('publish 将 REVIEWED 任务变为 PUBLISHED', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'REVIEWED',
      pageId: 'page-1',
    })
    const svc = createTaskService(prisma)
    const task = await svc.publish('task-1')
    expect(task.status).toBe('PUBLISHED')
    expect(prisma.optimizationTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'PUBLISHED' },
    })
  })

  it('publish 非 REVIEWED 任务时报错', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'PENDING',
    })
    const svc = createTaskService(prisma)
    await expect(svc.publish('task-1')).rejects.toThrow()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/content-optimizer/task-service.test.ts`
预期：FAIL，模块找不到。

- [ ] **步骤 3：编写实现**

创建 `src/modules/content-optimizer/task-service.ts`：

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

export interface TaskService {
  create(input: CreateTaskInput): Promise<OptimizationTask>
  list(workspaceId: string, status?: TaskStatus): Promise<OptimizationTask[]>
  getById(id: string): Promise<OptimizationTask | null>
  review(id: string, approved: boolean, note?: string): Promise<OptimizationTask>
  publish(id: string): Promise<OptimizationTask>
}

export function createTaskService(prisma: PrismaClient): TaskService {
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
        // 同时更新关联的 ContentPage
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
      return updated
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/content-optimizer/task-service.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/content-optimizer/task-service.ts src/modules/content-optimizer/task-service.test.ts
git commit -m "feat(content-optimizer): add OptimizationTaskService with review workflow"
```

---

## 任务 8：Orchestrator（流水线编排）

**文件：**
- 创建：`src/modules/content-optimizer/orchestrator.ts`
- 测试：`src/modules/content-optimizer/orchestrator.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/content-optimizer/orchestrator.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createOrchestrator } from './orchestrator.js'
import type { Atom, ScoredAtom, FaqPair } from './types.js'

function makeScoredAtom(text: string, total: number): ScoredAtom {
  return {
    text,
    subject: 'x',
    predicate: 'y',
    object: 'z',
    anchors: ['123'],
    score: {
      total,
      hasNumericAnchor: total >= 35,
      hasEntityAnchor: total >= 60,
      isSelfContained: true,
      hasDefinition: total >= 75,
    },
  }
}

describe('Orchestrator', () => {
  const mockAtoms: Atom[] = [
    { text: '段落1', subject: 'a', predicate: 'b', object: 'c', anchors: ['123'] },
  ]

  function makeDeps(overrides: any = {}) {
    const defaultScored: ScoredAtom[] = [makeScoredAtom('段落1', 85)]
    const defaultFaqs: FaqPair[] = [
      { question: 'Q?', answer: 'A', source: 'llm_generated' },
    ]

    return {
      atomizer: {
        atomize: vi.fn().mockResolvedValue(mockAtoms),
        ...overrides.atomizer,
      },
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue(defaultScored),
        scorePage: vi.fn().mockReturnValue(85),
        ...overrides.scoring,
      },
      rewriter: {
        rewriteBatch: vi.fn().mockImplementation(async (atoms: ScoredAtom[]) => atoms),
        ...overrides.rewriter,
      },
      faqGenerator: {
        generate: vi.fn().mockResolvedValue(defaultFaqs),
        ...overrides.faqGenerator,
      },
      taskService: {
        create: vi.fn().mockResolvedValue({ id: 'task-1' }),
        ...overrides.taskService,
      },
      prisma: {
        contentPage: {
          upsert: vi.fn().mockResolvedValue({ id: 'page-1' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        ...overrides.prisma,
      },
    }
  }

  it('完整流水线：atomize → score → rewrite → faq → 组装结果', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: '原始内容',
    })

    expect(deps.atomizer.atomize).toHaveBeenCalledWith('原始内容')
    expect(deps.scoring.scoreAtoms).toHaveBeenCalled()
    expect(deps.rewriter.rewriteBatch).toHaveBeenCalled()
    expect(deps.faqGenerator.generate).toHaveBeenCalled()
    expect(result.atoms).toHaveLength(1)
    expect(result.faqs).toHaveLength(1)
    expect(result.overallScore).toBe(85)
  })

  it('所有 atom 达标时 rewrittenCount 为 0', async () => {
    const deps = makeDeps({
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue([makeScoredAtom('a', 100)]),
        scorePage: vi.fn().mockReturnValue(100),
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
    })

    expect(result.rewrittenCount).toBe(0)
  })

  it('部分不达标时记录 rewrittenCount', async () => {
    const lowScore = makeScoredAtom('低分', 40)
    const highScore = makeScoredAtom('高分', 90)
    const rewrittenLow = makeScoredAtom('低分-改写后', 85)

    const deps = makeDeps({
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue([lowScore, highScore]),
        scorePage: vi.fn().mockReturnValue(85),
      },
      rewriter: {
        rewriteBatch: vi.fn().mockResolvedValue([rewrittenLow, highScore]),
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
    })

    expect(deps.rewriter.rewriteBatch).toHaveBeenCalled()
    expect(result.rewrittenCount).toBe(1)
  })

  it('报告指标正确计算', async () => {
    const atoms: ScoredAtom[] = [
      makeScoredAtom('a', 85),
      makeScoredAtom('b', 40),
    ]
    const deps = makeDeps({
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue(atoms),
        scorePage: vi.fn().mockReturnValue(62),
      },
      rewriter: {
        rewriteBatch: vi.fn().mockResolvedValue([
          makeScoredAtom('a', 85),
          makeScoredAtom('b-改', 80),
        ]),
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
    })

    // 两个 atom 都达标 → atomizationRate = 1.0
    expect(result.report.atomizationRate).toBe(1)
    // 两个都 isSelfContained → independenceRate = 1.0
    expect(result.report.independenceRate).toBe(1)
  })

  it('创建 OptimizationTask', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
      url: 'https://example.com',
      pageType: 'landing',
    })

    expect(deps.taskService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        type: 'REWRITE_CONTENT',
      }),
    )
  })

  it('传入 pageId 时读取已有 ContentPage 内容', async () => {
    const deps = makeDeps({
      prisma: {
        contentPage: {
          upsert: vi.fn(),
          findUnique: vi.fn().mockResolvedValue({
            id: 'page-1',
            currentContent: '已有内容',
            workspaceId: 'w1',
          }),
        },
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    await orchestrator.optimize({
      workspaceId: 'w1',
      content: '',
      pageId: 'page-1',
    })

    expect(deps.prisma.contentPage.findUnique).toHaveBeenCalledWith({ where: { id: 'page-1' } })
    expect(deps.atomizer.atomize).toHaveBeenCalledWith('已有内容')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/content-optimizer/orchestrator.test.ts`
预期：FAIL，模块找不到。

- [ ] **步骤 3：编写实现**

创建 `src/modules/content-optimizer/orchestrator.ts`：

```typescript
import type { PrismaClient } from '@prisma/client'
import type { Atom, ScoredAtom, FaqPair, OptimizationResult } from './types.js'
import type { AtomizerService } from './atomizer.js'
import type { ScoringService } from './scoring.js'
import type { RewriterService } from './rewriter.js'
import type { FaqGeneratorService } from './faq-generator.js'
import type { TaskService } from './task-service.js'

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

export interface OrchestratorDeps {
  atomizer: AtomizerService
  scoring: ScoringService
  rewriter: RewriterService
  faqGenerator: FaqGeneratorService
  taskService: TaskService
  prisma: PrismaClient
}

export function createOrchestrator(deps: OrchestratorDeps): OrchestratorService {
  return {
    async optimize(input) {
      // 1. 获取内容
      let content = input.content
      let pageId = input.pageId

      if (input.pageId) {
        const page = await deps.prisma.contentPage.findUnique({
          where: { id: input.pageId },
        })
        if (page) {
          content = page.currentContent
        }
      }

      // 2. 原子化
      const atoms: Atom[] = await deps.atomizer.atomize(content)
      if (atoms.length === 0) {
        return {
          atoms: [],
          faqs: [],
          overallScore: 0,
          rewrittenCount: 0,
          report: { atomizationRate: 0, independenceRate: 0, faqCoverage: 0 },
        }
      }

      // 3. 评分
      const scoredAtoms: ScoredAtom[] = deps.scoring.scoreAtoms(atoms)
      const beforeScore = deps.scoring.scorePage(scoredAtoms)
      const needsRewrite = scoredAtoms.filter((a) => a.score.total < 70).length

      // 4. 重写不达标的
      const rewrittenAtoms: ScoredAtom[] = await deps.rewriter.rewriteBatch(scoredAtoms)
      const afterScore = deps.scoring.scorePage(rewrittenAtoms)

      // 5. 生成 FAQ
      const faqs: FaqPair[] = await deps.faqGenerator.generate({
        atoms: rewrittenAtoms,
        workspaceId: input.workspaceId,
      })

      // 6. 计算报告指标
      const passedAtoms = rewrittenAtoms.filter((a) => a.score.total >= 70).length
      const independentAtoms = rewrittenAtoms.filter((a) => a.score.isSelfContained).length
      const coveredFaqs = faqs.filter((f) => f.matchedQueryId).length

      const result: OptimizationResult = {
        atoms: rewrittenAtoms,
        faqs,
        overallScore: afterScore,
        rewrittenCount: needsRewrite,
        report: {
          atomizationRate: rewrittenAtoms.length > 0 ? passedAtoms / rewrittenAtoms.length : 0,
          independenceRate: rewrittenAtoms.length > 0 ? independentAtoms / rewrittenAtoms.length : 0,
          faqCoverage: faqs.length > 0 ? coveredFaqs / faqs.length : 0,
        },
      }

      // 7. 更新或创建 ContentPage
      if (input.url) {
        const page = await deps.prisma.contentPage.upsert({
          where: { workspaceId_url: { workspaceId: input.workspaceId, url: input.url } },
          create: {
            workspaceId: input.workspaceId,
            url: input.url,
            pageType: input.pageType || 'landing',
            currentContent: content,
            optimizedContent: JSON.stringify(result),
            optimizationScore: afterScore,
          },
          update: {
            optimizedContent: JSON.stringify(result),
            optimizationScore: afterScore,
          },
        })
        pageId = page.id
      }

      // 8. 创建审核任务
      await deps.taskService.create({
        workspaceId: input.workspaceId,
        type: 'REWRITE_CONTENT',
        pageId,
        beforeScore,
        afterScore,
        result: {
          overallScore: result.overallScore,
          rewrittenCount: result.rewrittenCount,
          report: result.report,
        },
      })

      return result
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/content-optimizer/orchestrator.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/content-optimizer/orchestrator.ts src/modules/content-optimizer/orchestrator.test.ts
git commit -m "feat(content-optimizer): add Orchestrator for pipeline coordination"
```

---

## 任务 9：contentRouter（tRPC 路由）

**文件：**
- 创建：`src/modules/content-optimizer/router.ts`
- 测试：`src/modules/content-optimizer/router.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/content-optimizer/router.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { contentRouter } from './router.js'

function createCaller(ctx: any) {
  return contentRouter.createCaller(ctx)
}

describe('content router', () => {
  const mockOrchestrator = {
    optimize: vi.fn().mockResolvedValue({
      atoms: [],
      faqs: [],
      overallScore: 85,
      rewrittenCount: 1,
      report: { atomizationRate: 1, independenceRate: 1, faqCoverage: 0.5 },
    }),
  }
  const mockAtomizer = {
    atomize: vi.fn().mockResolvedValue([
      { text: 'atom', subject: 'x', predicate: 'y', object: 'z', anchors: [] },
    ]),
  }
  const mockFaqGenerator = {
    generate: vi.fn().mockResolvedValue([
      { question: 'Q', answer: 'A', source: 'llm_generated' },
    ]),
  }
  const mockPrisma = {
    contentPage: {
      upsert: vi.fn().mockImplementation(async (args: any) => ({
        id: 'page-1',
        ...args.create,
      })),
      findMany: vi.fn().mockResolvedValue([
        { id: 'page-1', url: 'https://example.com', status: 'DRAFT' },
      ]),
      findUnique: vi.fn().mockResolvedValue({ id: 'page-1', url: 'https://example.com' }),
    },
  }

  const ctx = {
    workspace: { id: 'w1' },
    services: {
      orchestrator: mockOrchestrator,
      atomizer: mockAtomizer,
      faqGenerator: mockFaqGenerator,
      prisma: mockPrisma,
    },
  } as any

  beforeEach(() => vi.clearAllMocks())

  it('optimize 触发完整流水线', async () => {
    const caller = createCaller(ctx)
    const result = await caller.optimize({
      content: '原始内容',
      url: 'https://example.com',
    })
    expect(mockOrchestrator.optimize).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        content: '原始内容',
      }),
    )
    expect(result.overallScore).toBe(85)
  })

  it('atomize 单独原子化', async () => {
    const caller = createCaller(ctx)
    const result = await caller.atomize({ text: '测试文本' })
    expect(mockAtomizer.atomize).toHaveBeenCalledWith('测试文本')
    expect(result.atoms).toHaveLength(1)
  })

  it('generateFaq 单独生成 FAQ', async () => {
    const caller = createCaller(ctx)
    const result = await caller.generateFaq({ topic: 'AI设计', count: 3 })
    expect(mockFaqGenerator.generate).toHaveBeenCalled()
    expect(result.faqs).toHaveLength(1)
  })

  it('pages.upsert 创建或更新页面', async () => {
    const caller = createCaller(ctx)
    await caller.pages.upsert({
      url: 'https://example.com',
      pageType: 'landing',
      currentContent: '内容',
    })
    expect(mockPrisma.contentPage.upsert).toHaveBeenCalled()
    const args = mockPrisma.contentPage.upsert.mock.calls[0][0]
    expect(args.create.workspaceId).toBe('w1')
  })

  it('pages.list 按 workspace 查询页面', async () => {
    const caller = createCaller(ctx)
    const result = await caller.pages.list()
    expect(mockPrisma.contentPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'w1' }) }),
    )
    expect(result).toHaveLength(1)
  })

  it('pages.list 按状态过滤', async () => {
    const caller = createCaller(ctx)
    await caller.pages.list({ status: 'draft' })
    expect(mockPrisma.contentPage.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'DRAFT' },
    })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/content-optimizer/router.test.ts`
预期：FAIL，模块找不到。

- [ ] **步骤 3：编写实现**

创建 `src/modules/content-optimizer/router.ts`：

```typescript
import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

export const contentRouter = router({
  pages: router({
    upsert: protectedProcedure
      .input(z.object({
        url: z.string(),
        pageType: z.string(),
        currentContent: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.prisma.contentPage.upsert({
          where: {
            workspaceId_url: {
              workspaceId: ctx.workspace.id,
              url: input.url,
            },
          },
          create: {
            workspaceId: ctx.workspace.id,
            url: input.url,
            pageType: input.pageType,
            currentContent: input.currentContent,
          },
          update: {
            pageType: input.pageType,
            currentContent: input.currentContent,
          },
        })
      }),

    list: protectedProcedure
      .input(
        z.object({
          status: z.enum(['draft', 'reviewed', 'published']).optional(),
        }).optional(),
      )
      .query(async ({ ctx, input }) => {
        const where: any = { workspaceId: ctx.workspace.id }
        if (input?.status) {
          where.status = input.status.toUpperCase()
        }
        return ctx.services.prisma.contentPage.findMany({ where })
      }),

    get: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ ctx, input }) => {
        return ctx.services.prisma.contentPage.findUnique({
          where: { id: input.id },
        })
      }),
  }),

  optimize: protectedProcedure
    .input(z.object({
      pageId: z.string().optional(),
      content: z.string().optional(),
      url: z.string().optional(),
      pageType: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.orchestrator.optimize({
        workspaceId: ctx.workspace.id,
        content: input.content || '',
        pageId: input.pageId,
        url: input.url,
        pageType: input.pageType,
      })
    }),

  atomize: protectedProcedure
    .input(z.object({ text: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const atoms = await ctx.services.atomizer.atomize(input.text)
      return { atoms }
    }),

  generateFaq: protectedProcedure
    .input(z.object({
      topic: z.string(),
      count: z.number().min(1).max(20).default(5),
    }))
    .mutation(async ({ ctx, input }) => {
      const faqs = await ctx.services.faqGenerator.generate({
        atoms: [{ text: input.topic, subject: '', predicate: '', object: '', anchors: [] }],
        workspaceId: ctx.workspace.id,
        count: input.count,
      })
      return { faqs }
    }),
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/content-optimizer/router.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/content-optimizer/router.ts src/modules/content-optimizer/router.test.ts
git commit -m "feat(content-optimizer): add contentRouter with page management and optimization APIs"
```

---

## 任务 10：taskRouter（任务审核路由）

**文件：**
- 创建：`src/modules/content-optimizer/task-router.ts`
- 测试：`src/modules/content-optimizer/task-router.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/modules/content-optimizer/task-router.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { taskRouter } from './task-router.js'

function createCaller(ctx: any) {
  return taskRouter.createCaller(ctx)
}

describe('task router', () => {
  const mockTaskService = {
    list: vi.fn().mockResolvedValue([{ id: 'task-1', status: 'PENDING' }]),
    getById: vi.fn().mockResolvedValue({ id: 'task-1', status: 'PENDING' }),
    review: vi.fn().mockResolvedValue({ id: 'task-1', status: 'REVIEWED' }),
    publish: vi.fn().mockResolvedValue({ id: 'task-1', status: 'PUBLISHED' }),
  }

  const ctx = {
    workspace: { id: 'w1' },
    services: { taskService: mockTaskService },
  } as any

  beforeEach(() => vi.clearAllMocks())

  it('list 按 workspace 查询任务', async () => {
    const caller = createCaller(ctx)
    const result = await caller.list()
    expect(mockTaskService.list).toHaveBeenCalledWith('w1', undefined)
    expect(result).toHaveLength(1)
  })

  it('list 按状态过滤', async () => {
    const caller = createCaller(ctx)
    await caller.list({ status: 'pending' })
    expect(mockTaskService.list).toHaveBeenCalledWith('w1', 'PENDING')
  })

  it('get 查询单个任务', async () => {
    const caller = createCaller(ctx)
    const result = await caller.get({ id: 'task-1' })
    expect(mockTaskService.getById).toHaveBeenCalledWith('task-1')
    expect(result.id).toBe('task-1')
  })

  it('review approve', async () => {
    const caller = createCaller(ctx)
    const result = await caller.review({ id: 'task-1', approved: true })
    expect(mockTaskService.review).toHaveBeenCalledWith('task-1', true, undefined)
    expect(result.status).toBe('REVIEWED')
  })

  it('review reject with note', async () => {
    const caller = createCaller(ctx)
    await caller.review({ id: 'task-1', approved: false, note: '需要修改' })
    expect(mockTaskService.review).toHaveBeenCalledWith('task-1', false, '需要修改')
  })

  it('publish 发布已审核任务', async () => {
    const caller = createCaller(ctx)
    const result = await caller.publish({ id: 'task-1' })
    expect(mockTaskService.publish).toHaveBeenCalledWith('task-1')
    expect(result.status).toBe('PUBLISHED')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/modules/content-optimizer/task-router.test.ts`
预期：FAIL，模块找不到。

- [ ] **步骤 3：编写实现**

创建 `src/modules/content-optimizer/task-router.ts`：

```typescript
import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

export const taskRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        status: z.enum(['pending', 'in_progress', 'reviewed', 'published', 'failed']).optional(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const status = input?.status ? input.status.toUpperCase() as any : undefined
      return ctx.services.taskService.list(ctx.workspace.id, status)
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.services.taskService.getById(input.id)
    }),

  review: protectedProcedure
    .input(z.object({
      id: z.string(),
      approved: z.boolean(),
      note: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.taskService.review(input.id, input.approved, input.note)
    }),

  publish: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.taskService.publish(input.id)
    }),
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/modules/content-optimizer/task-router.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/modules/content-optimizer/task-router.ts src/modules/content-optimizer/task-router.test.ts
git commit -m "feat(content-optimizer): add taskRouter with review and publish APIs"
```

---

## 任务 11：集成到主路由和 Server

**文件：**
- 修改：`src/router.ts`
- 修改：`src/server.ts`

- [ ] **步骤 1：更新主路由**

修改 `src/router.ts`，添加 contentRouter 和 taskRouter：

```typescript
import { router } from './core/trpc/init.js'
import { workspaceRouter } from './core/workspace/router.js'
import { citationRouter } from './modules/citation-monitor/router.js'
import { contentRouter } from './modules/content-optimizer/router.js'
import { taskRouter } from './modules/content-optimizer/task-router.js'

export const appRouter = router({
  workspace: workspaceRouter,
  citation: citationRouter,
  content: contentRouter,
  tasks: taskRouter,
})

export type AppRouter = typeof appRouter
```

- [ ] **步骤 2：更新 server.ts 组装组件**

修改 `src/server.ts` 的 `main()` 函数。在现有 `services` 定义之前添加 content-optimizer 组件组装：

在 `import` 部分添加：

```typescript
import { createAtomizer } from './modules/content-optimizer/atomizer.js'
import { createScoringEngine } from './modules/content-optimizer/scoring.js'
import { createRewriter } from './modules/content-optimizer/rewriter.js'
import { createFaqGenerator } from './modules/content-optimizer/faq-generator.js'
import { createTaskService } from './modules/content-optimizer/task-service.js'
import { createOrchestrator } from './modules/content-optimizer/orchestrator.js'
```

在 `const queryLibrary = ...` 之后、`const services = ...` 之前添加：

```typescript
  // 组装 content-optimizer 组件
  const atomizer = createAtomizer(getLlmProvider())
  const scoring = createScoringEngine()
  const rewriter = createRewriter(getLlmProvider())
  const faqGenerator = createFaqGenerator(getLlmProvider(), prisma)
  const taskService = createTaskService(prisma)
  const orchestrator = createOrchestrator({
    atomizer, scoring, rewriter, faqGenerator, taskService, prisma,
  })
```

更新 `services` 对象：

```typescript
  const services = {
    prisma, monitor, queryLibrary,
    orchestrator, taskService, atomizer, faqGenerator,
  }
```

- [ ] **步骤 3：验证编译**

运行：`npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 4：Commit**

```bash
git add src/router.ts src/server.ts
git commit -m "feat(content-optimizer): integrate content and task routers into server"
```

---

## 任务 12：全量测试验证

**文件：** 无新建文件

- [ ] **步骤 1：运行全量测试**

运行：`npx vitest run`
预期：所有测试通过，包括阶段 1 的 43 个测试 + 阶段 2 新增测试。

- [ ] **步骤 2：如有失败，修复后重新运行**

逐个检查失败的测试，修复实现或测试代码。常见问题：
- Prisma 模型字段名拼写（如 `workspaceId_url` 复合唯一约束）
- mock 对象缺少方法
- import 路径 `.js` 扩展名

- [ ] **步骤 3：最终 commit（如有修复）**

```bash
git add -A
git commit -m "test(content-optimizer): fix test failures from integration"
```

---

## 自检

**1. 规格覆盖度：**

| 规格章节 | 覆盖任务 |
|---------|---------|
| 二、模块架构 | 任务 8（Orchestrator） |
| 三、核心数据结构 | 任务 2（types.ts） |
| 三、评分规则 | 任务 3（ScoringEngine） |
| 四、数据库变更 | 任务 1（Prisma Schema） |
| 五.1 ContentAtomizer | 任务 4 |
| 五.2 ScoringEngine | 任务 3 |
| 五.3 LlmRewriter | 任务 5 |
| 五.4 FaqGenerator | 任务 6 |
| 五.5 OptimizationTaskService | 任务 7 |
| 五.6 AtomizerOrchestrator | 任务 8 |
| 六、tRPC 路由 | 任务 9 + 10 + 11 |
| 七、测试策略 | 每个任务内含测试 |
| SDK 接口（content.optimize/atomize/generateFaq/pages） | 任务 9 |
| SDK 接口（tasks.list/review/publish） | 任务 10 |

无遗漏。

**2. 占位符扫描：** 无 TODO / 待定 / 模糊描述。每个步骤包含完整代码块。

**3. 类型一致性：**
- `Atom` / `ScoredAtom` / `FaqPair` / `OptimizationResult` 在任务 2 定义，任务 3-8 引用，名称一致
- `ScoringService.scoreAtoms()` / `scorePage()` 在任务 3 定义，任务 5（rewriter）和任务 8（orchestrator）引用，签名一致
- `AtomizerService.atomize()` 在任务 4 定义，任务 8 引用
- `RewriterService.rewriteBatch()` 在任务 5 定义，任务 8 引用
- `FaqGeneratorService.generate()` 在任务 6 定义，任务 8 和任务 9 引用
- `TaskService.create/list/getById/review/publish` 在任务 7 定义，任务 8 和任务 10 引用
- Prisma 复合唯一约束 `workspaceId_url` 在任务 1 schema 和任务 8 orchestrator 中一致
