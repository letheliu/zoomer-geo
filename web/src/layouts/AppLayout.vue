<script setup lang="ts">
import { h, type Component, computed } from 'vue'
import { NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NMenu, NSwitch, NIcon, NButton, NSpace } from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import { RouterView, useRouter, useRoute } from 'vue-router'
import { useAppStore } from '../stores/app'
import { useAuthStore } from '../stores/auth'

const appStore = useAppStore()
const authStore = useAuthStore()
const router = useRouter()
const route = useRoute()

function renderIcon(emoji: string) {
  return () => h('span', { style: { fontSize: '16px' } }, emoji)
}

const menuOptions: MenuOption[] = [
  {
    label: '概览',
    key: 'dashboard',
    icon: renderIcon('📊'),
  } as MenuOption,
  {
    label: '引用监测',
    key: 'citation-group',
    type: 'group',
    children: [
      { label: '查询库', key: 'citation-queries', icon: renderIcon('🔍') } as MenuOption,
      { label: '引用报告', key: 'citation-reports', icon: renderIcon('📋') } as MenuOption,
      { label: 'SOV 分析', key: 'citation-sov', icon: renderIcon('📈') } as MenuOption,
      { label: '效果对比', key: 'citation-effect', icon: renderIcon('⚖️') } as MenuOption,
    ],
  },
  {
    label: '内容优化',
    key: 'content-group',
    type: 'group',
    children: [
      { label: '内容页面', key: 'content-pages', icon: renderIcon('📄') } as MenuOption,
      { label: '优化任务', key: 'content-tasks', icon: renderIcon('✅') } as MenuOption,
    ],
  },
  {
    label: 'Schema 生成',
    key: 'schema-group',
    type: 'group',
    children: [
      { label: 'Schema 记录', key: 'schema-records', icon: renderIcon('📚') } as MenuOption,
      { label: '生成 JSON-LD', key: 'schema-generate', icon: renderIcon('⚙️') } as MenuOption,
      { label: 'llms.txt 编辑器', key: 'schema-llms-txt', icon: renderIcon('📝') } as MenuOption,
    ],
  },
  {
    label: '知识图谱',
    key: 'kg-group',
    type: 'group',
    children: [
      { label: '实体管理', key: 'kg-entities', icon: renderIcon('🔷') } as MenuOption,
      { label: '关系管理', key: 'kg-relations', icon: renderIcon('🔗') } as MenuOption,
      { label: '图谱可视化', key: 'kg-graph', icon: renderIcon('🌐') } as MenuOption,
    ],
  },
  {
    label: '设置',
    key: 'settings',
    icon: renderIcon('⚙️'),
  } as MenuOption,
]

const activeKey = computed(() => route.name as string)

function handleMenuUpdate(key: string) {
  router.push({ name: key })
}

function handleLogout() {
  authStore.logout()
  router.push({ name: 'setup' })
}
</script>

<template>
  <NLayout has-sider style="height: 100vh">
    <NLayoutSider
      bordered
      :collapsed="appStore.collapsed"
      collapse-mode="width"
      :collapsed-width="64"
      :width="220"
      show-trigger
      @collapse="appStore.collapsed = true"
      @expand="appStore.collapsed = false"
    >
      <div style="padding: 16px 20px; font-weight: 700; font-size: 16px; white-space: nowrap; overflow: hidden">
        {{ appStore.collapsed ? 'G' : 'GEO Console' }}
      </div>
      <NMenu
        :value="activeKey"
        :collapsed="appStore.collapsed"
        :collapsed-width="64"
        :collapsed-icon-size="18"
        :options="menuOptions"
        @update:value="handleMenuUpdate"
      />
    </NLayoutSider>
    <NLayout>
      <NLayoutHeader bordered style="height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px">
        <NSpace align="center">
          <NSpace align="center" :size="8">
            <span style="font-size: 14px; color: var(--text-color-3)">API Key:</span>
            <code style="font-size: 12px; opacity: 0.7">
              {{ authStore.apiKey.slice(0, 8) }}••••••
            </code>
          </NSpace>
        </NSpace>
        <NSpace align="center">
          <NSwitch :value="appStore.darkMode" @update:value="appStore.toggleDarkMode" size="small">
            <template #checked>暗色</template>
            <template #unchecked>亮色</template>
          </NSwitch>
          <NButton size="small" quaternary @click="handleLogout">退出</NButton>
        </NSpace>
      </NLayoutHeader>
      <NLayoutContent style="padding: 24px" content-style="overflow: auto;">
        <RouterView />
      </NLayoutContent>
    </NLayout>
  </NLayout>
</template>
