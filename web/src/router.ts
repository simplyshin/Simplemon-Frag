import { createRouter, createWebHistory } from 'vue-router';

/** 页头路径配置（PageHeader 未收到 crumbs prop 时自动读取并解析） */
declare module 'vue-router' {
  interface RouteMeta {
    /** 页头标题兜底（页面通常用动态数据自行传 title） */
    title?: string;
    /** 祖先路径层级；to 支持 :param 令牌（从 route.params / PageHeader params prop 解析）。
     *  最后一级（当前页）不用配，PageHeader 自动取 title。 */
    crumbs?: { text: string; to?: string }[];
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'projects', component: () => import('./views/ProjectsView.vue'), meta: { title: '项目管理' } },
    {
      path: '/project/:id',
      name: 'documents',
      component: () => import('./views/DocumentsView.vue'),
      meta: { crumbs: [{ text: '项目管理', to: '/' }] },
    },
    {
      path: '/project/:id/graph',
      name: 'doc-graph',
      component: () => import('./views/GraphView.vue'),
      meta: {
        crumbs: [
          { text: '项目管理', to: '/' },
          { text: '文档列表', to: '/project/:id' },
        ],
      },
    },
    {
      path: '/doc/:id',
      name: 'doc-detail',
      component: () => import('./views/DocumentDetailView.vue'),
      // :projectId 由文档详情页在数据加载后通过 PageHeader 的 params prop 提供
      meta: {
        crumbs: [
          { text: '项目管理', to: '/' },
          { text: '文档列表', to: '/project/:projectId' },
        ],
      },
    },
    { path: '/search', name: 'search', component: () => import('./views/SearchView.vue'), meta: { title: '文档检索' } },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { title: 'Provider 设置' } },
  ],
});
