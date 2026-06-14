---
name: vue3-naive-spa-scaffolding
description: 从零搭建 Vue 3 + Naive UI + TypeScript + Vite SPA 前端时的常见陷阱与修复方法，覆盖 npm 本地依赖协议、vue-tsc 类型检查错误、Vue 模板语法限制等
source: auto-skill
extracted_at: '2026-06-14T02:05:28.457Z'
---

# Vue 3 + Naive UI + TypeScript SPA 脚手架陷阱清单

## 何时使用

当从零创建 Vue 3 + Naive UI + Vite + TypeScript 单页应用前端时，参照此清单可避免反复 trial-and-error。这些条目均来自实际构建中遇到的错误。

## 本地 SDK / 包依赖

**问题：** `package.json` 中 `"@scope/geo-sdk": "link:../sdk"` 导致 `npm install` 报错 `EUNSUPPORTEDPROTOCOL`。

**修复：** npm 不支持 `link:` 协议（那是 pnpm/yarn 的语法）。改用 `file:` 协议：
```json
"@scope/geo-sdk": "file:../sdk"
```

## vue-tsc 类型检查常见错误

### 1. `<script setup>` 中使用 `computed` / `watchEffect` 但未导入

Vue 3 的 `<script setup>` **不会**自动导入 Composition API 函数。每个 `.vue` 文件必须显式导入：

```vue
<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue'  // ← 必须导入
</script>
```

**排查方法：** vue-tsc 报 `TS2304: Cannot find name 'computed'` → 检查该文件是否遗漏了 vue 导入。

### 2. 模板中直接使用 `localStorage` / `window`

Vue 模板无法直接访问浏览器全局对象（`localStorage`、`window` 等）。必须先存入 ref：

```vue
<!-- ❌ 报错 TS2339 -->
<code>{{ localStorage.getItem('key') }}</code>

<!-- ✅ 正确 -->
<script setup>
const apiKeyDisplay = ref(localStorage.getItem('key') || '')
</script>
<code>{{ apiKeyDisplay }}</code>
```

### 3. `useRouter` 从错误的包导入

`useRouter` 来自 `vue-router`，不是 `naive-ui`。混在一行导入会报 `TS2614`：

```ts
// ❌
import { NButton, useMessage, useRouter } from 'naive-ui'

// ✅ 分开导入
import { NButton, useMessage } from 'naive-ui'
import { useRouter } from 'vue-router'
```

### 4. 导入路径相对位置错误

当一个文件从 `src/composables/useTrpc.ts` 引用 `src/api/client.ts` 时，路径是 `../api/client`，不是 `./client`。移动文件后务必检查相对路径。

## Vue 模板语法限制

### 模板字面量不能直接用在属性值中

```vue
<!-- ❌ Vite 构建报错：Unquoted attribute value cannot contain U+0022 -->
<NCollapseItem title={`FAQ (${count})`} />

<!-- ✅ 用 v-bind 绑定 -->
<NCollapseItem :title="`FAQ (${count})`" />
```

## Naive UI 组件类型陷阱

### MenuOption 的 icon 和 children 类型

Naive UI 的 `MenuOption` 是联合类型（`MenuOption | MenuGroupOption | MenuDividerOption`）。TS 会报 `Property 'type' is missing`。解决：

1. icon 必须返回 `VNodeChild`，不能返回 `Component`：
```ts
// ❌ 返回 Component 类型不匹配
function renderIcon(icon: string): Component { return () => h(NIcon, ...) }

// ✅ 直接返回渲染函数
function renderIcon(emoji: string) {
  return () => h('span', { style: { fontSize: '16px' } }, emoji)
}
```

2. 子菜单项需要 `as MenuOption` 断言：
```ts
const menuOptions: MenuOption[] = [
  { label: '概览', key: 'dashboard', icon: renderIcon('📊') } as MenuOption,
  {
    label: '引用监测', key: 'g1', type: 'group',  // group 类型需显式声明
    children: [
      { label: '查询库', key: 'queries', icon: renderIcon('🔍') } as MenuOption,
    ],
  },
]
```

## 验证流程

脚手架完成后，按顺序验证：

```bash
# 1. 类型检查（先于构建，能快速发现大部分问题）
npx vue-tsc --noEmit

# 2. 生产构建
npx vite build
```

只有两步都零错误才算完成。vue-tsc 能捕获模板中不合法的表达式和类型不匹配，但 Vite 构建能发现 vue-tsc 遗漏的模板语法问题（如未引用的属性值中的特殊字符），所以两步都需要执行。
