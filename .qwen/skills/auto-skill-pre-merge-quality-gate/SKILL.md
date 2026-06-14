---
name: pre-merge-quality-gate
description: 多任务子代理驱动开发完成后、合并回主干前的最后质量关卡 — 派发"跨任务/跨模块审查"子代理扫描单元任务审查无法发现的问题（多租户隔离、组件集成不匹配、数据生命周期、错误吞噬），并在 main 分支上 re-verify 测试与 tsc 状态。用于 subagent-driven-development 完成所有任务后、finishing-a-development-branch 之前。
source: auto-skill
extracted_at: '2026-06-14T01:25:34.689Z'
---

# 合并前质量关卡

多任务子代理开发（subagent-driven-development 或 executing-plans）完成后，每个任务都经历了"实施 + 规格审查 + 代码审查"两到三轮检查。但**单元任务审查天然有盲区**：

- 实施者只看到自己任务的代码，无法跨任务审视"这个 `findById` 不带 workspaceId 过滤"是否安全
- 规格审查对照任务边界，无法发现"AutoSections 输出格式与 LlmsTxtBuilder 期望格式不一致"这类跨组件契约漏洞
- 代码审查聚焦风格/可读性，漏掉"循环里 `catch {}` 静默吞噬错误"这类跨任务累积的运维盲点

本技能沉淀两个动作：**派发跨任务审查子代理** + **main 分支 re-verify**。两者都是合并到主干前的强制关卡。

## 何时使用

- 子代理驱动开发（subagent-driven-development）的所有任务已完成
- 每个任务都通过了它自己的"实施 + 审查"轮次
- 准备调用 finishing-a-development-branch 合并 feature 分支到 main

**不在以下场景使用：**
- 单元小改动（1-3 个文件，无需 worktree 隔离的）
- 仅文档/配置变更
- 任务列表中跨任务耦合点已经被显式标注并验证过

## 模式 1：派发跨任务审查子代理

### 触发信号

- 任务数量 ≥ 10
- 修改了既有阶段代码（如 phase 3 修改 phase 2 的 `task-service.ts`）
- 涉及多租户/多 workspace 数据隔离
- 涉及跨模块数据流（一个模块的输出是另一个模块的输入）
- 涉及数据库 schema 变更

### 审查子代理的提示词骨架

```markdown
你是最终代码审查子代理，对 [feature 名称] 整体实现做审查。

## 工作目录
[worktree 绝对路径]
## 分支
[feature-branch]
## 基础
git log [base-sha]..HEAD 列出本次实现的所有 commit

## 范围
[本次实现的 1-2 句话范围描述]

## 测试现状
- `npx vitest run` → [N 个 test file / M 个 test 全部通过]
- `npx tsc --noEmit` → [N 个错误 / 0 错误]

## 你的工作
整体审查 [feature] 实现，输出：
1. 优点
2. 问题（关键 / 重要 / 次要）
3. 评估结论：是否可合并

## 审查重点（按相关性排序）
- **多租户隔离**：所有 DB 查询是否带 workspaceId 过滤？所有 tRPC 路由是否从 ctx.workspace.id 注入？
- **组件集成契约**：模块 A 的输出格式是否与模块 B 的输入期望一致？是否有跨组件的格式假设未被显式契约化？
- **数据生命周期**：append-only 表（如 version 化的 schema 记录）有无清理机制？永久累积的字段会引发存储增长？
- **错误处理一致性**：跨模块的错误类是否统一？catch 块是否静默吞噬？
- **静态资源复用**：白名单/常量/类型是否在多个文件中重复定义？是否应该 import 而非重新声明？
- **文件大小**：任何单文件 > 200 行是否合理？
- **性能热点**：N+1 查询、全表扫描、循环里串行 await
- **类型先行 vs 实现漂移**：spec 文档的字段名/类型，跨任务引用是否一致？
- **与既有阶段代码风格的一致性**：DI 模式、错误类命名、工厂函数模式

## 报告格式
- 优点（列表）
- 问题（按 BLOCKER / MAJOR / MINOR 分组）
- 结论：可合并 / 需先修复（哪些问题）
```

### 关键设计原则

**1. 强调"跨任务视角"**
子代理不能只读 commit-by-commit diff。明确告诉它"不要只验证规格符合性，要找单元任务之间未对齐的盲点"。

**2. 提供具体的"重点清单"**
不要泛泛说"做最终审查"。给出 5-8 个具体的审查维度（多租户隔离 / 集成契约 / 数据生命周期 / ...）。子代理才有抓手。

**3. 报告分严重程度**
要求 BLOCKER / MAJOR / MINOR 三档。BLOCKER 阻塞合并，MAJOR 应修但可后置 PR，MINOR 可选。

### 修复 BLOCKER + 关键 MAJOR 后重新审查

按审查发现的问题分类处理：
- **BLOCKER**（如跨租户数据污染、API key 泄露）：必须修复后重新派审查子代理
- **MAJOR**（如 workspace 隔离缺失、数据无限增长）：合并前应修，**不必**重新派审查（实施者确认修复 + 跑全量测试即可）
- **MINOR**：留作后续 PR 优化

修复后无需再走完整规格审查轮次，只需：
1. 派发修复子代理（明确修改范围）
2. 修复子代理自审 + 运行全量测试 + 提交
3. 用户确认

## 模式 2：main 分支 re-verify（关键防呆步骤）

**为什么需要：** worktree 中的 `npx tsc --noEmit` 干净 ≠ main 分支上 `tsc` 干净。常见陷阱：

- worktree 与 main 共享 `node_modules`（gitignored），但 `prisma generate` 写入 `node_modules/.prisma/client/` 的时机在 worktree 中完成
- merge 之后，main 分支上 `tsc` 看到的是合并后的代码 + main 分支最近一次 `prisma generate` 的产物
- 如果 main 分支在 worktree 创建之后没有 re-run `prisma generate`，新引入的 Prisma 模型/字段会让 tsc 报 40+ "Module has no exported member" 错误

### re-verify 步骤

```bash
# 1. 合并到 main（按 finishing-a-development-branch 流程）
git checkout main
git merge feature/xxx --no-ff -m "..."

# 2. 立即 re-verify（在 main 目录运行）
npx prisma generate           # 如果含 Prisma 变更
npx vitest run                 # 全部测试
npx tsc --noEmit               # 类型检查
```

预期：vitest 全过、tsc 零错误。如果有失败，**不要先 commit 修改**——先确认是不是 worktree 状态丢失，再修复。

### 修复 prisma generate 后的 "Module has no exported member" 错误

症状：合并后 `npx tsc --noEmit` 报：
```
error TS2305: Module '"@prisma/client"' has no exported member 'KgEntity'
error TS2339: Property 'kgEntity' does not exist on type 'PrismaClient'
```

原因：worktree 里跑过 `npx prisma generate` 但产物写在 `node_modules/.pnpm/...`，可能因为 pnpm 符号链接/虚拟存储路径问题，main 目录的 tsc 看不到。

修复：直接在 main 目录跑 `npx prisma generate`，会重写 client 产物。无需 commit（产物在 gitignored `node_modules`）。

## 反模式（避免）

- ❌ **跳过最终审查直接合并**："每个任务都过了，所以整体应该没问题" — 跨任务盲区是单元任务审查的固有缺陷
- ❌ **让实施任务的子代理同时做最终审查**：它对自己刚写的代码有"作者盲点"，且上下文已被自己工作污染
- ❌ **审查只对照规格符合性**：这是规格审查者的工作，最终审查必须超越规格看跨任务对齐
- ❌ **合并后才在 main 跑 tsc**：应该在合并后**立即**跑，否则后续 commit 会让问题定位困难
- ❌ **遇到 tsc 错误就修改业务代码**：多数情况是 prisma generate 缺失或 node_modules 状态不一致，业务代码无需动
- ❌ **一次性修复所有 BLOCKER+MAJOR+MINOR**：MINOR 可留作后续 PR，强行一次清完会拖慢合并节奏

## 与其他技能的关系

- **subagent-driven-development**：本技能是它的工作流收尾。该技能的"分派最终代码审查"步骤正是本技能的模式 1
- **finishing-a-development-branch**：本技能必须在它之前完成（否则合并后才发现问题需 revert）
- **plan-quality-patterns**：本技能解决的是"即使计划完美、单元任务全过仍可能漏掉的问题"，与该技能互补
- **verification-before-completion**：广义原则要求"声称完成前先验证"，本技能是该原则在多任务场景的具体化

## 工作流串联

完整的多任务实现工作流：

1. **写 spec**（brainstorming 产出）
2. **写计划**（writing-plans 产出 + plan-quality-patterns 强化）
3. **执行任务**（subagent-driven-development 派发每个任务）
4. **本技能触发点**（所有任务完成后）：
   - 模式 1：派发跨任务审查子代理
   - 修复 BLOCKER + 关键 MAJOR
   - 模式 2：合并到 main + 立即 re-verify
5. **finishing-a-development-branch**：清理 worktree、删分支（如本技能用 worktree 隔离工作）
