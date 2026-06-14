<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  NCard, NForm, NFormItem, NInput, NButton, NSpace, NTag, useMessage,
} from 'naive-ui'
import PageHeader from '../components/common/PageHeader.vue'
import { trpc } from '../composables/useTrpc'

const message = useMessage()
const loading = ref(true)
const saving = ref(false)

const apiKeyDisplay = ref('')

const wsInfo = ref<any>(null)
const platformConfig = ref<Record<string, string>>({
  OPENAI_API_KEY: '',
  PERPLEXITY_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  GEMINI_API_KEY: '',
  DEEPSEEK_API_KEY: '',
})

const platformLabels: Record<string, string> = {
  OPENAI_API_KEY: 'OpenAI',
  PERPLEXITY_API_KEY: 'Perplexity',
  ANTHROPIC_API_KEY: 'Anthropic',
  GEMINI_API_KEY: 'Gemini',
  DEEPSEEK_API_KEY: 'DeepSeek',
}

onMounted(async () => {
  const key = localStorage.getItem('geo-api-key') || ''
  apiKeyDisplay.value = key.slice(0, 12) + '••••'
  try {
    // Try to get workspace info by making a test query
    const queries = await trpc.citation.queries.list.query()
    loading.value = false
  } catch {
    loading.value = false
  }

  // Load existing platform config
  try {
    // We'll use the workspace register endpoint to check, but we need a dedicated endpoint
    // For now, load from workspace data if available
  } catch {
    //
  }
})

async function handleSave() {
  saving.value = true
  try {
    // Build config object - only non-empty values
    const config: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(platformConfig.value)) {
      if (value.trim()) config[key] = value.trim()
    }

    // Use the auth store's apiKey
    const apiKey = localStorage.getItem('geo-api-key') || ''
    await trpc.workspace.setPlatformConfig.mutate({
      apiKey,
      config,
    })
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
        <NSpace vertical>
          <div style="font-size: 13px; color: var(--text-color-3)">
            API Key:
            <code>{{ apiKeyDisplay }}</code>
          </div>
        </NSpace>
      </NCard>

      <NCard title="平台凭证 (API Keys)">
        <NForm label-placement="top">
          <NFormItem v-for="(label, key) in platformLabels" :key="key" :label="label">
            <NInput
              v-model:value="platformConfig[key]"
              :placeholder="`${label} API Key`"
              type="password"
              show-password-on="click"
            />
          </NFormItem>
          <NSpace justify="end">
            <NButton type="primary" :loading="saving" @click="handleSave">保存</NButton>
          </NSpace>
        </NForm>
      </NCard>
    </NSpace>
  </div>
</template>
