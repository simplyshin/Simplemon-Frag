<script setup lang="ts">
import { useRoute } from 'vue-router';
import { computed, ref } from 'vue';
import { Document, Search, Setting, Folder, Fold, Expand } from '@element-plus/icons-vue';

const route = useRoute();
const collapsed = ref(false);

const activeMenu = computed(() => {
  if (route.path.startsWith('/project')) return route.params.id as string;
  return route.path;
});

const menuItems = [
  { index: '/', icon: Folder, label: '项目管理' },
  { index: '/search', icon: Search, label: '文档检索' },
  { index: '/settings', icon: Setting, label: 'Provider 设置' },
];
</script>

<template>
  <el-container class="app-shell">
    <el-aside :width="collapsed ? '64px' : '220px'" class="app-aside">
      <div class="app-logo" :class="{ 'logo-mini': collapsed }">
        <template v-if="!collapsed">doc-mcp 后台</template>
        <template v-else>DM</template>
      </div>
      <el-menu
        :default-active="activeMenu" router class="app-menu"
        :collapse="collapsed" :collapse-transition="false"
      >
        <el-menu-item v-for="m in menuItems" :key="m.index" :index="m.index">
          <el-icon><component :is="m.icon" /></el-icon>
          <template #title>{{ m.label }}</template>
        </el-menu-item>
      </el-menu>
      <div class="app-aside-footer">
        <el-tooltip :content="collapsed ? '展开菜单' : '收起菜单'" placement="right">
          <el-button text :icon="collapsed ? Expand : Fold" class="collapse-btn" @click="collapsed = !collapsed" />
        </el-tooltip>
        <span v-if="!collapsed" class="mcp-hint">
          <el-icon style="vertical-align: -2px"><Document /></el-icon>
          MCP 端点: /mcp
        </span>
      </div>
    </el-aside>
    <el-main class="app-main">
      <router-view />
    </el-main>
  </el-container>
</template>

<style>
/* ---------- 全局：简约拟物风（Soft UI）设计基 ---------- */
:root {
  --app-bg: #eef1f6;
  --app-surface: #ffffff;
  --app-border: #e6eaf2;
  --app-shadow:
    0 1px 2px rgba(31, 45, 61, 0.04),
    0 6px 18px rgba(31, 45, 61, 0.06);
  --app-shadow-hover:
    0 2px 4px rgba(31, 45, 61, 0.05),
    0 10px 26px rgba(31, 45, 61, 0.09);
}
html, body, #app {
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: var(--app-bg);
  font-family: 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
/* 基础布局间距：页头（PageHeader）与首个内容块之间的统一 margin */
.page-body {
  margin-top: 16px;
}
/* 卡片：圆角 + 柔和悬浮阴影（拟物层次） */
.el-card {
  border-radius: 12px !important;
  border: 1px solid var(--app-border) !important;
  box-shadow: var(--app-shadow) !important;
  transition: box-shadow 0.2s ease;
}
.el-card:hover {
  box-shadow: var(--app-shadow-hover) !important;
}
/* 按钮与输入控件统一圆角 */
.el-button { border-radius: 8px; }
.el-input__wrapper, .el-select__wrapper, .el-textarea__inner { border-radius: 8px; }
/* 表格圆角容器感 */
.el-table { --el-table-border-color: var(--app-border); border-radius: 10px; }
/* 对话框与消息统一圆角 */
.el-dialog { border-radius: 14px; }
/* markdown 预览排版 */
.md-body {
  line-height: 1.75;
  font-size: 14px;
  color: var(--el-text-color-primary);
  word-break: break-word;
}
.md-body h1, .md-body h2, .md-body h3, .md-body h4 {
  margin: 1.2em 0 0.5em;
  line-height: 1.4;
}
.md-body h1 { font-size: 22px; }
.md-body h2 { font-size: 19px; }
.md-body h3 { font-size: 16px; }
.md-body p { margin: 0.6em 0; }
.md-body pre {
  background: #f4f6fa;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 12px;
  overflow: auto;
}
.md-body code {
  background: #f4f6fa;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 13px;
}
.md-body pre code { background: none; padding: 0; }
.md-body blockquote {
  margin: 0.6em 0;
  padding: 4px 12px;
  border-left: 3px solid var(--el-color-primary-light-5);
  background: #f7f9fc;
  color: var(--el-text-color-secondary);
  border-radius: 0 6px 6px 0;
}
.md-body table {
  border-collapse: collapse;
  margin: 0.8em 0;
}
.md-body th, .md-body td {
  border: 1px solid var(--app-border);
  padding: 6px 12px;
}
.md-body th { background: #f4f6fa; }
.md-body ul, .md-body ol { padding-left: 1.6em; margin: 0.5em 0; }
.md-body img { max-width: 100%; }
.md-body hr { border: none; border-top: 1px solid var(--app-border); margin: 1.2em 0; }
</style>

<style scoped>
.app-shell {
  height: 100vh;
  background: var(--app-bg);
}
.app-aside {
  background: var(--app-surface);
  border-right: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  transition: width 0.25s ease;
  overflow: hidden;
}
.app-logo {
  height: 72px; /* = 页 padding 20px + 标题行 32px 的一半 → logo 与页面标题垂直中心对齐 */
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 16px;
  font-weight: 700;
  font-size: 15px;
  white-space: nowrap;
  color: var(--el-text-color-primary);
}
.logo-mini {
  justify-content: center;
  padding: 0;
  color: var(--el-color-primary);
}
.app-menu {
  border-right: none;
  flex: 1;
}
.app-aside-footer {
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--app-border);
}
.collapse-btn {
  font-size: 16px;
}
.mcp-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.app-main {
  padding: 0;
  background: var(--app-bg);
  overflow: auto;
}
</style>
