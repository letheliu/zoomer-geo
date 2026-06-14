<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NCard, NGrid, NGridItem, NStatistic, NSpace, NEmpty, NSpin, NTag } from 'naive-ui'
import { trpc } from '../composables/useTrpc'

const loading = ref(true)
const sovScore = ref<number>(0)
const totalEvents = ref<number>(0)
const mentionedCount = ref<number>(0)
const queryCount = ref<number>(0)
const pendingTasks = ref<number>(0)
const recentEvents = ref<any[]>([])

onMounted(async () => {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 86400000)
  const dateRange = {
    start: weekAgo.toISOString(),
    end: now.toISOString(),
  }

  try {
    const [sov, queries, tasks, report] = await Promise.all([
      trpc.citation.getSovScore.query({ competitors: [], dateRange }),
      trpc.citation.queries.list.query(),
      trpc.tasks.list.query({ status: 'pending' }),
      trpc.citation.getReport.query({ dateRange }),
    ])

    sovScore.value = Math.round(sov.sovScore * 100)
    totalEvents.value = sov.totalEvents
    mentionedCount.value = sov.mentionedCount
    queryCount.value = Array.isArray(queries) ? queries.length : 0
    pendingTasks.value = Array.isArray(tasks) ? tasks.length : 0
    recentEvents.value = (report.events || []).slice(0, 5)
  } catch (e: any) {
    console.error('Dashboard load failed:', e)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <NSpin :show="loading">
    <NSpace vertical :size="24">
      <NGrid :cols="4" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic label="SOV 分数（近 7 天）" :value="sovScore">
              <template #suffix>%</template>
            </NStatistic>
          </NCard>
        </NGridItem>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic label="监测覆盖" :value="queryCount">
              <template #suffix>queries</template>
            </NStatistic>
          </NCard>
        </NGridItem>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic label="引用事件" :value="totalEvents">
              <template #suffix>| 提及 {{ mentionedCount }} 次</template>
            </NStatistic>
          </NCard>
        </NGridItem>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic label="待审任务" :value="pendingTasks" />
          </NCard>
        </NGridItem>
      </NGrid>

      <NCard title="最近引用事件">
        <NEmpty v-if="recentEvents.length === 0 && !loading" description="暂无数据" />
        <NSpace v-else vertical :size="8">
          <div
            v-for="ev in recentEvents"
            :key="ev.id"
            style="display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--divider-color)"
          >
            <NTag :type="ev.brandMentioned ? 'success' : 'default'" size="small">
              {{ ev.brandMentioned ? '✅ 提及' : '❌ 未提及' }}
            </NTag>
            <span style="flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {{ ev.queryId }}
            </span>
            <NTag size="small" type="info">{{ ev.platform }}</NTag>
            <span v-if="ev.rankInAnswer" style="font-size: 12px; color: var(--text-color-3)">
              排名 #{{ ev.rankInAnswer }}
            </span>
            <span style="font-size: 12px; color: var(--text-color-3)">
              SOV {{ ev.sovScore ? (ev.sovScore * 100).toFixed(0) + '%' : '-' }}
            </span>
          </div>
        </NSpace>
      </NCard>
    </NSpace>
  </NSpin>
</template>
