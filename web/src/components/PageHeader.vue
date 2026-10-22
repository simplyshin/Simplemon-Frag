<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft } from '@element-plus/icons-vue';

/** 统一页头：返回按钮 + 路径面包屑 + 标题 + 右侧操作区（简约拟物风统一导航） */
export interface Crumb { text: string; to?: string }

const props = defineProps<{
  /** 手动指定路径（覆盖路由 meta 自动生成）；一般页面无需传 */
  crumbs?: Crumb[];
  /** 页面标题（自动模式下同时作为路径最后一级文本） */
  title: string;
  /** 路由 meta crumbs 中 :param 令牌的补充解析值（如文档详情的 projectId，依赖异步数据） */
  params?: Record<string, string | undefined>;
}>();

const route = useRoute();
const router = useRouter();

/** :param 令牌解析；存在未解析令牌时该层级降级为纯文本（无链接） */
function resolveTo(to: string | undefined): string | undefined {
  if (!to) return undefined;
  const out = to.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) =>
    String(route.params[name] ?? props.params?.[name] ?? `:${name}`));
  return out.includes(':') ? undefined : out;
}

/** 路径层级：手动 crumbs 优先；否则读路由 meta + 追加当前页（title） */
const resolvedCrumbs = computed<Crumb[]>(() => {
  if (props.crumbs?.length) return props.crumbs;
  const metaCrumbs = (route.meta.crumbs as Crumb[] | undefined) ?? [];
  const list = metaCrumbs.map((c) => ({ text: c.text, to: resolveTo(c.to) }));
  // 最后一级面包屑为当前页面标题，无跳转链接
  list.push({ text: props.title, to: undefined });
  return list;
});

// 返回目标 = 倒数第二级（有 to 才显示返回按钮）。
// 必须 computed：crumbs 可能依赖异步数据（如文档详情的 project_id），加载完成后按钮才应出现
const backTarget = computed<Crumb | null>(() => {
  const list = resolvedCrumbs.value;
  if (list.length < 2) return null;
  const prev = list[list.length - 2];
  return prev.to ? prev : null;
});
</script>

<template>
  <div class="page-header">
    <div class="page-title-row">
      <div class="page-title-wrap">
        <h2 class="page-title">{{ title }}</h2>
        <slot name="title-extra" />
      </div>
      <div class="page-actions"><slot /></div>
    </div>
    <div v-if="resolvedCrumbs.length > 1" class="page-crumbs">
      <el-tooltip v-if="backTarget" content="返回上一级" placement="top">
        <el-button :icon="ArrowLeft" text class="back-btn" @click="router.push(backTarget!.to!)" />
      </el-tooltip>
      <el-breadcrumb separator="/">
        <el-breadcrumb-item v-for="(c, i) in resolvedCrumbs" :key="i" :to="c.to">{{ c.text }}</el-breadcrumb-item>
      </el-breadcrumb>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  margin-bottom: 0px;
}
.page-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  min-height: 32px;
}
.page-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 32px; /* 与 el-button 默认 32px 高度一致，保证标题与按钮同一水平线 */
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.page-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}
/* el-upload 内嵌按钮与相邻按钮基线对齐 */
.page-actions :deep(.el-upload) {
  display: inline-flex;
  align-items: center;
}
.page-crumbs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  /* 与标题、正文同一左缘（页 padding），返回键不再额外缩进 */
  padding-left: 0;
}
.back-btn {
  color: var(--el-text-color-secondary);
  font-size: 16px;
  padding: 0; /* 纯图标返回键，左缘与标题/统计行严格对齐 */
  min-width: 0;
}
.page-crumbs :deep(.el-breadcrumb) {
  font-size: 13px;
  line-height: 20px;
}
</style>
