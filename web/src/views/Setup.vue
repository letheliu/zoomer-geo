<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { NCard, NForm, NFormItem, NInput, NButton, NSpace, NTabs, NTabPane, useMessage } from 'naive-ui'
import { useAuthStore } from '../stores/auth'
import { setApiKey } from '../api/client'
import { trpc } from '../composables/useTrpc'

const router = useRouter()
const message = useMessage()
const authStore = useAuthStore()

// Login tab
const apiKeyInput = ref('')

function handleLogin() {
  if (!apiKeyInput.value.trim()) {
    message.warning('请输入 API Key')
    return
  }
  authStore.setApiKey(apiKeyInput.value.trim())
  setApiKey(apiKeyInput.value.trim())
  message.success('已连接')
  router.push({ name: 'dashboard' })
}

// Register tab
const regForm = ref({ name: '', defaultBrandName: '', domain: '' })
const regLoading = ref(false)
const newApiKey = ref('')

async function handleRegister() {
  if (!regForm.value.name || !regForm.value.defaultBrandName) {
    message.warning('请填写名称和品牌名')
    return
  }
  regLoading.value = true
  try {
    const result = await trpc.workspace.register.mutate({
      name: regForm.value.name,
      defaultBrandName: regForm.value.defaultBrandName,
      domain: regForm.value.domain || undefined,
    })
    newApiKey.value = result.apiKey
    message.success('Workspace 创建成功')
  } catch (e: any) {
    message.error('创建失败: ' + (e?.message || String(e)))
  } finally {
    regLoading.value = false
  }
}

function useNewKey() {
  if (!newApiKey.value) return
  authStore.setApiKey(newApiKey.value)
  setApiKey(newApiKey.value)
  message.success('已自动连接')
  router.push({ name: 'dashboard' })
}
</script>

<template>
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--body-color)">
    <NCard style="width: 520px; max-width: 90vw" title="GEO Console" size="medium">
      <NTabs type="line" animated>
        <NTabPane name="login" tab="连接已有 Workspace">
          <NForm @submit.prevent="handleLogin">
            <NFormItem label="API Key">
              <NInput v-model:value="apiKeyInput" placeholder="geo_xxxxxxxx..." type="password" show-password-on="click" />
            </NFormItem>
            <NButton type="primary" block @click="handleLogin">连接</NButton>
          </NForm>
        </NTabPane>
        <NTabPane name="register" tab="注册新 Workspace">
          <template v-if="!newApiKey">
            <NForm @submit.prevent="handleRegister">
              <NFormItem label="名称">
                <NInput v-model:value="regForm.name" placeholder="我的工作区" />
              </NFormItem>
              <NFormItem label="品牌名">
                <NInput v-model:value="regForm.defaultBrandName" placeholder="zoomer.top" />
              </NFormItem>
              <NFormItem label="域名（可选）">
                <NInput v-model:value="regForm.domain" placeholder="zoomer.top" />
              </NFormItem>
              <NButton type="primary" block :loading="regLoading" @click="handleRegister">创建</NButton>
            </NForm>
          </template>
          <template v-else>
            <NSpace vertical :size="16">
              <div style="font-size: 14px; line-height: 1.8">
                ✅ Workspace 创建成功！<br />
                请保存你的 API Key（仅显示一次）：
              </div>
              <NInput :value="newApiKey" type="textarea" readonly :rows="2" />
              <NButton type="primary" block @click="useNewKey">使用此 Key 连接</NButton>
            </NSpace>
          </template>
        </NTabPane>
      </NTabs>
    </NCard>
  </div>
</template>
