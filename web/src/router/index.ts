import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/setup',
      name: 'setup',
      component: () => import('../views/Setup.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('../layouts/AppLayout.vue'),
      children: [
        {
          path: '',
          name: 'dashboard',
          component: () => import('../views/Dashboard.vue'),
        },
        {
          path: 'citation/queries',
          name: 'citation-queries',
          component: () => import('../views/citation/QueryLibrary.vue'),
        },
        {
          path: 'citation/reports',
          name: 'citation-reports',
          component: () => import('../views/citation/Reports.vue'),
        },
        {
          path: 'citation/sov',
          name: 'citation-sov',
          component: () => import('../views/citation/SovAnalytics.vue'),
        },
        {
          path: 'citation/effect',
          name: 'citation-effect',
          component: () => import('../views/citation/EffectComparison.vue'),
        },
        {
          path: 'content/pages',
          name: 'content-pages',
          component: () => import('../views/content/Pages.vue'),
        },
        {
          path: 'content/pages/:id',
          name: 'content-page-detail',
          component: () => import('../views/content/PageDetail.vue'),
        },
        {
          path: 'content/tasks',
          name: 'content-tasks',
          component: () => import('../views/content/Tasks.vue'),
        },
        {
          path: 'schema/records',
          name: 'schema-records',
          component: () => import('../views/schema/Records.vue'),
        },
        {
          path: 'schema/generate',
          name: 'schema-generate',
          component: () => import('../views/schema/Generate.vue'),
        },
        {
          path: 'schema/llms-txt',
          name: 'schema-llms-txt',
          component: () => import('../views/schema/LlmsTxt.vue'),
        },
        {
          path: 'kg/entities',
          name: 'kg-entities',
          component: () => import('../views/kg/Entities.vue'),
        },
        {
          path: 'kg/relations',
          name: 'kg-relations',
          component: () => import('../views/kg/Relations.vue'),
        },
        {
          path: 'kg/graph',
          name: 'kg-graph',
          component: () => import('../views/kg/Graph.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('../views/Settings.vue'),
        },
      ],
    },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'setup' }
  }
  if (to.name === 'setup' && auth.isAuthenticated) {
    return { name: 'dashboard' }
  }
})
