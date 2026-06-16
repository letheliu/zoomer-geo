<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  NCard, NForm, NFormItem, NInput, NButton, NSpace, NDynamicInput, useMessage,
} from 'naive-ui'
import PageHeader from '../components/common/PageHeader.vue'
import { trpc } from '../composables/useTrpc'

const message = useMessage()
const saving = ref(false)
const apiKeyDisplay = ref('')

const competitors = ref<string[]>([])

const platforms = ref([
  {
    key: 'deepseek',
    label: 'DeepSeek',
    fields: [
      { envKey: 'DEEPSEEK_API_KEY', label: 'API Key', value: '' },
      { envKey: 'DEEPSEEK_BASE_URL', label: 'Base URL（可选）', value: '' },
      { envKey: 'DEEPSEEK_MODEL', label: 'Model（可选）', value: '' },
    ],
  },
  {
    key: 'doubao',
    label: '豆包（火山引擎）',
    fields: [
      { envKey: 'DOUBAO_API_KEY', label: 'API Key', value: '' },
      { envKey: 'DOUBAO_BASE_URL', label: 'Base URL（可选）', value: '' },
      { envKey: 'DOUBAO_MODEL', label: 'Model（可选）', value: '' },
    ],
  },
  {
    key: 'qwen',
    label: '通义千问（阿里云）',
    fields: [
      { envKey: 'QWEN_API_KEY', label: 'API Key', value: '' },
      { envKey: 'QWEN_BASE_URL', label: 'Base URL（可选）', value: '' },
      { envKey: 'QWEN_MODEL', label: 'Model（可选）', value: '' },
    ],
  },
  {
    key: 'ernie',
    label: '文心一言（百度）',
    fields: [
      { envKey: 'ERNIE_API_KEY', label: 'API Key', value: '' },
      { envKey: 'ERNIE_SECRET_KEY', label: 'Secret Key', value: '' },
      { envKey: 'ERNIE_MODEL', label: 'Model（可选）', value: '' },
    ],
  },
])

onMounted(async () => {
  const key = localStorage.getItem('geo-api-key') || ''
  apiKeyDisplay.value = key.slice(0, 12) + '••••'

  try {
    const ws = await trpc.workspace.get.query() as any
    if (!ws) return
    const cfg = (ws.platformConfig as Record<string, any>) || {}

    for (const p of platforms.value) {
      const pCfg = cfg[p.key] || {}
      for (const f of p.fields) {
        f.value = pCfg[f.envKey] || ''
      }
    }
    competitors.value = Array.isArray(cfg.competitors) ? cfg.competitors : []
  } catch {
    // workspace may not exist yet
  }
})

async function handleSave() {
  saving.value = true
  try {
    const config: Record<string, any> = {}
    for (const p of platforms.value) {
      const pCfg: Record<string, string> = {}
      for (const f of p.fields) {
        if (f.value.trim()) pCfg[f.envKey] = f.value.trim()
      }
      if (Object.keys(pCfg).length > 0) config[p.key] = pCfg
    }
    config.competitors = competitors.value.filter(Boolean)

    const apiKey = localStorage.getItem('geo-api-key') || ''
    await trpc.workspace.setPlatformConfig.mutate({ apiKey, config })
    message.success('已保存')
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader title="设置" subtitle="工作区与平台凭证配置" />

    <NSpace vertical :size="16">
      <NCard title="工作区信息">
        <div style="font-size: 13px; color: var(--text-color-3)">
          API Key: <code>{{ apiKeyDisplay }}</code>
        </div>
      </NCard>

      <NCard v-for="p in platforms" :key="p.key" :title="p.label">
        <NForm label-placement="top">
          <NFormItem v-for="f in p.fields" :key="f.envKey" :label="f.label">
            <NInput
              v-model:value="f.value"
              :placeholder="f.label"
              :type="f.envKey.includes('KEY') || f.envKey.includes('SECRET') ? 'password' : 'text'"
              show-password-on="click"
            />
          </NFormItem>
        </NForm>
      </NCard>

      <NCard title="竞品配置">
        <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 12px">
          配置竞品品牌名后，监测时会自动分析竞品在 AI 答案中的排名
        </div>
        <NSpace vertical>
          <div v-for="(_, i) in competitors" :key="i" style="display: flex; gap: 8px; align-items: center">
            <NInput v-model:value="competitors[i]" placeholder="竞品品牌名" />
            <NButton quaternary type="error" @click="competitors.splice(i, 1)">删除</NButton>
          </div>
          <NButton @click="competitors.push('')">+ 添加竞品</NButton>
        </NSpace>
      </NCard>

      <NSpace justify="end">
        <NButton type="primary" :loading="saving" @click="handleSave">保存全部</NButton>
      </NSpace>
    </NSpace>
  </div>
</template>
