<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Connection } from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import { api, type DocCategory, type DocumentFull } from '../api';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([GraphChart, LegendComponent, TooltipComponent, CanvasRenderer]);

/** 与后端 projectGraph 返回结构对应 */
interface GraphNode {
  id: string; title: string; source_type: string; doc_type: string;
  version_no: number; updated_at: string; link_count: number;
}
interface GraphEdge { source_id: string; target_id: string; type: string; score: number; reason: string }

const route = useRoute();
const projectId = route.params.id as string;

const nodes = ref<GraphNode[]>([]);
const edges = ref<GraphEdge[]>([]);
const categories = ref<DocCategory[]>([]);
const loading = ref(false);
/** 点击锁定的选中节点；再次点击取消 */
const selectedId = ref<string | null>(null);
/** 当前生效的高亮节点：点击锁定优先（ECharts 悬浮高亮由内置 emphasis 处理） */
const activeId = computed(() => selectedId.value);
/** 相似度阈值：低于该值的弱关联边默认隐藏 */
const threshold = ref(0.85);
/** 每节点最多显示的最强关联数；0 = 不限（边降噪核心手段） */
const topK = ref(4);
/** 标签显示：all=全部（超出自动互让/隐藏重叠） key=枢纽节点 none=隐藏 */
const labelMode = ref<'key' | 'all' | 'none'>('all');
/** 完整文件名开关：关闭时截断 12 字 */
const showFullNames = ref(false);
/** 斥力档位：越大同簇节点间越松散 */
const repulsion = ref(350);
/** 隐藏的分类（与 ECharts 图例选中态同步） */
const hiddenCats = ref<string[]>([]);

// ---------- 分类着色（与文档列表 CategoryTag 同色系） ----------
const PRESET_HEX: Record<string, string> = {
  primary: '#409eff', success: '#67c23a', info: '#909399', warning: '#e6a23c', danger: '#f56c6c',
};
const FALLBACK_PALETTE = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#9c66e8', '#00c4cc', '#ff7d00', '#909399'];
const FALLBACK_NAME = '未分类';

const catOf = (t: string) => categories.value.find((c) => c.id === t);
const catName = (t: string) => catOf(t)?.name ?? FALLBACK_NAME;
const catColor = (t: string) => {
  const c = catOf(t);
  if (!c) return FALLBACK_PALETTE[0];
  if (c.color.startsWith('#')) return c.color;
  return PRESET_HEX[c.color] ?? '#909399';
};

/** 阈值过滤 + 每节点 Top-K 截断（边已按分数降序） */
const shownEdges = computed(() => {
  const list = edges.value.filter((e) => e.score >= threshold.value);
  if (!topK.value) return list;
  const perNode = new Map<string, number>();
  const kept: GraphEdge[] = [];
  for (const e of list) {
    const cs = perNode.get(e.source_id) ?? 0;
    const ct = perNode.get(e.target_id) ?? 0;
    if (cs >= topK.value || ct >= topK.value) continue;
    perNode.set(e.source_id, cs + 1);
    perNode.set(e.target_id, ct + 1);
    kept.push(e);
  }
  return kept;
});

interface RelatedItem {
  node: GraphNode;
  edge: GraphEdge;
  preview: string;
  previewLoading: boolean;
  /** 内容默认折叠，点击展开时才拉取 */
  expanded: boolean;
}
const relatedItems = ref<RelatedItem[]>([]);

const selectedNode = computed(() => nodes.value.find((n) => n.id === activeId.value) ?? null);
const nodeById = computed(() => new Map(nodes.value.map((n) => [n.id, n])));

const relatedCount = computed(() => edges.value.length);

/** 重点节点：关联数 Top15 + 锁定节点 */
const topDegreeIds = computed(() =>
  new Set([...nodes.value].sort((a, b) => b.link_count - a.link_count).slice(0, 15).map((n) => n.id)),
);

// ---------- ECharts 图表 ----------
const containerRef = ref<HTMLDivElement | null>(null);
let chart: echarts.EChartsType | null = null;
let resizeOb: ResizeObserver | null = null;

/** ECharts 分类定义（按节点数降序排列） */
const echCategories = computed(() => {
  const counts = new Map<string, number>();
  for (const n of nodes.value) counts.set(n.doc_type, (counts.get(n.doc_type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({ id, name: catName(id), color: catColor(id) }));
});

const truncateTitle = (t: string, selected = false) => {
  if (showFullNames.value || selected) return t;
  return t.length > 12 ? t.slice(0, 11) + '…' : t;
};

/** 构建并应用 option（数据变化时整体刷新；force 布局在同一数据引用下继续演算） */
function applyOption() {
  if (!chart) return;
  const cats = echCategories.value;
  const catIndex = new Map(cats.map((c, i) => [c.id, i]));
  const visible = nodes.value.filter((n) => !hiddenCats.value.includes(n.doc_type));
  const visIds = new Set(visible.map((n) => n.id));
  const useEdges = shownEdges.value.filter((e) => visIds.has(e.source_id) && visIds.has(e.target_id));

  const data = visible.map((n) => ({
    id: n.id,
    name: labelMode.value === 'key' && !topDegreeIds.value.has(n.id) && n.id !== selectedId.value
      ? '' // 重点模式下非枢纽节点不带标签
      : truncateTitle(n.title),
    category: catIndex.get(n.doc_type) ?? 0,
    symbolSize: 10 + Math.min(n.link_count * 1.1, 26),
    value: n.link_count,
    raw: n,
  }));

  const links = useEdges.map((e) => ({
    source: e.source_id,
    target: e.target_id,
    value: e.score,
    lineStyle: {
      width: 0.6 + e.score * 1.6,
      opacity: 0.2 + e.score * 0.45,
      color: e.type === 'manual' ? '#e6a23c' : 'source',
    },
    raw: e,
  }));

  chart.setOption({
    backgroundColor: '#fafbfd',
    legend: [{
      data: cats.map((c) => c.name),
      selected: Object.fromEntries(cats.map((c) => [c.name, !hiddenCats.value.includes(c.id)])),
      type: 'scroll',
      top: 8,
      left: 10,
      itemWidth: 12,
      itemHeight: 12,
      textStyle: { fontSize: 12, color: '#606266' },
    }],
    tooltip: {
      trigger: 'item',
      confine: true,
      textStyle: { fontSize: 12 },
      formatter: (p: any) => {
        if (p.dataType === 'edge') {
          const e: GraphEdge = p.data.raw;
          const s = nodeById.value.get(e.source_id);
          const t = nodeById.value.get(e.target_id);
          const color = e.type === 'manual' ? '#e6a23c' : '#67c23a';
          return `<div style="max-width:320px"><b style="color:${color}">${e.type === 'manual' ? '手动关联' : '自动关联'} ${e.score.toFixed(3)}</b>`
            + `<div style="margin-top:4px">${s?.title ?? ''}</div><div style="color:#909399">↕ ${e.reason}</div>`
            + `<div style="margin-top:4px">${t?.title ?? ''}</div></div>`;
        }
        const n: GraphNode = p.data.raw;
        return `<div style="max-width:320px"><b>${n.title}</b><br/>`
          + `<span style="color:#909399">${catName(n.doc_type)} · v${n.version_no} · 关联 ${n.link_count} 篇 · 点击锁定</span></div>`;
      },
    },
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      data,
      links,
      categories: cats.map((c) => ({ name: c.name, itemStyle: { color: c.color } })),
      force: {
        repulsion: repulsion.value,
        edgeLength: [70, 130],
        gravity: 0.08,
        friction: 0.15,
        layoutAnimation: true,
      },
      label: {
        show: labelMode.value !== 'none',
        position: 'right',
        distance: 6,
        fontSize: 11,
        color: '#303133',
        textBorderColor: '#fafbfd',
        textBorderWidth: 2,
      },
      labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
      lineStyle: { curveness: 0.15 },
      emphasis: {
        focus: 'adjacency',
        label: { show: true, fontWeight: 'bold', formatter: (p: any) => p.data.raw.title },
        lineStyle: { width: 2.5, opacity: 1 },
      },
      scaleLimit: { min: 0.3, max: 5 },
    }],
  });
}

/** getOption 里 link 的 source/target 可能是 id 或节点对象，统一取 id */
const linkEndId = (s: any) => (typeof s === 'object' && s !== null ? s.id : s);

/** 锁定态样式：锁定节点红描边 + 邻居/关联边高亮，其余节点与边淡化（合并 option，不打断布局演算） */
function applySelection() {
  if (!chart) return;
  const series: any = chart.getOption().series?.[0];
  if (!series?.data) return;
  const locked = selectedId.value;
  const neighborSet = new Set<string>();
  if (locked) {
    for (const l of series.links ?? []) {
      const sid = linkEndId(l.source);
      const tid = linkEndId(l.target);
      if (sid === locked) neighborSet.add(tid);
      else if (tid === locked) neighborSet.add(sid);
    }
  }
  const data = series.data.map((d: any) => {
    const isLocked = d.id === locked;
    const dimmed = !!locked && !isLocked && !neighborSet.has(d.id);
    return {
      ...d,
      itemStyle: isLocked
        ? { borderColor: '#f56c6c', borderWidth: 2.5, shadowBlur: 8, shadowColor: 'rgba(245,108,108,.6)', opacity: 1 }
        : dimmed
          ? { opacity: 0.15 }
          : {},
      label: isLocked
        ? { show: true, fontWeight: 'bold', formatter: d.raw.title }
        : dimmed
          ? { show: false }
          : {},
    };
  });
  const links = (series.links ?? []).map((l: any) => {
    const related = !locked || linkEndId(l.source) === locked || linkEndId(l.target) === locked;
    const raw = l.raw;
    return {
      ...l,
      lineStyle: {
        width: locked && related ? 2.4 : 0.6 + raw.score * 1.6,
        opacity: locked ? (related ? 0.9 : 0.05) : 0.2 + raw.score * 0.45,
        color: raw.type === 'manual' ? '#e6a23c' : 'source',
      },
    };
  });
  chart.setOption({ series: [{ data, links }] });
}

/** 悬浮高亮模式：未锁定时悬浮自动聚焦邻居；锁定期间关闭（hover 不再改变关联视图） */
function applyHoverMode() {
  chart?.setOption({
    series: [{ emphasis: { focus: selectedId.value ? 'none' : 'adjacency' } }],
  });
}

function initChart() {
  const el = containerRef.value;
  if (!el || chart) return;
  chart = echarts.init(el, undefined, { renderer: 'canvas' });
  // 图例切换 → 同步 hiddenCats（供右侧统计与过滤联动）
  chart.on('legendselectchanged', (p: any) => {
    const nameToId = new Map(echCategories.value.map((c) => [c.name, c.id]));
    hiddenCats.value = Object.entries(p.selected as Record<string, boolean>)
      .filter(([, on]) => !on)
      .map(([name]) => nameToId.get(name) ?? name)
      .filter((id) => nodes.value.some((n) => n.doc_type === id));
  });
  // 点击节点锁定；点击空白取消
  chart.on('click', (p: any) => {
    if (p.dataType === 'node') {
      selectedId.value = selectedId.value === p.data.id ? null : p.data.id;
    }
  });
  chart.getZr().on('click', (e: any) => {
    if (!e.target) deselect();
  });
  resizeOb = new ResizeObserver(() => chart?.resize());
  resizeOb.observe(el);
}

watch([shownEdges, hiddenCats, labelMode, showFullNames, repulsion], () => {
  applyOption();
  applyHoverMode();
  if (selectedId.value) applySelection();
});

/** 锁定/解锁：清掉悬浮残留高亮 → 切换悬浮模式 → 应用锁定样式 */
watch(selectedId, () => {
  if (!chart) return;
  chart.dispatchAction({ type: 'downplay' });
  applyHoverMode();
  applySelection();
});

// ---------- 点击锁定联动：重建右侧关联面板（展示全部关联，不受显示过滤器影响） ----------
watch([selectedId, edges], () => {
  const id = selectedId.value;
  relatedItems.value = [];
  if (!id) return;
  relatedItems.value = edges.value
    .filter((e) => e.source_id === id || e.target_id === id)
    .map((e) => {
      const otherId = e.source_id === id ? e.target_id : e.source_id;
      const other = nodeById.value.get(otherId);
      return other
        ? { node: other, edge: e, preview: '', previewLoading: false, expanded: false }
        : null;
    })
    .filter((r): r is RelatedItem => r !== null)
    .sort((a, b) => b.edge.score - a.edge.score);
});

function deselect() {
  selectedId.value = null;
}

/** 展开/收起关联文档内容；首次展开时才拉取正文 */
async function toggleExpand(item: RelatedItem) {
  item.expanded = !item.expanded;
  if (!item.expanded || item.preview || item.previewLoading) return;
  item.previewLoading = true;
  try {
    const d = await api<DocumentFull>('GET', `/api/documents/${item.node.id}`);
    item.preview = d.content.replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch {
    item.preview = '（内容加载失败）';
  }
  item.previewLoading = false;
}

async function load() {
  loading.value = true;
  deselect();
  try {
    const [g, cats] = await Promise.all([
      api<{ nodes: GraphNode[]; edges: GraphEdge[] }>('GET', `/api/projects/${projectId}/graph`),
      api<{ items: DocCategory[] }>('GET', '/api/doc-categories'),
    ]);
    categories.value = cats.items;
    edges.value = g.edges;
    nodes.value = g.nodes.map((n) => ({ ...n, doc_type: n.doc_type || 'other' }));
    hiddenCats.value = [];
    initChart();
    applyOption();
    if (!g.nodes.length) ElMessage.info('项目暂无文档');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

/** 项目级重建自动关联：全部文档两两重算（评分 = 质心×0.5 + 最大段落相似度×0.5） */
const rebuilding = ref(false);
async function rebuildLinks() {
  rebuilding.value = true;
  try {
    const r = await api<{ rebuilt: number; links: number }>(
      'POST', `/api/projects/${projectId}/links/rebuild`,
    );
    ElMessage.success(`已为 ${r.rebuilt} 篇文档重建 ${r.links} 条关联`);
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    rebuilding.value = false;
  }
}

onMounted(() => load());

onBeforeUnmount(() => {
  resizeOb?.disconnect();
  resizeOb = null;
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <!-- 整页适配视口高度：头部固定，中间区域弹性占满，内部各自滚动 -->
  <div style="height: 100%; padding: 20px; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden">
    <PageHeader title="关联拓扑" style="flex-shrink: 0">
      <el-button :icon="Connection" :loading="rebuilding" @click="rebuildLinks">重建关联</el-button>
    </PageHeader>
    <div class="page-body" style="margin-bottom: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap">
      <span style="color: var(--el-text-color-secondary); font-size: 13px">
        {{ nodes.length }} 篇文档 · 显示 {{ shownEdges.length }}/{{ relatedCount }} 条关联
      </span>
      <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap">
        <div style="display: flex; align-items: center; gap: 8px">
          <span style="font-size: 12px; color: var(--el-text-color-secondary)">相似度阈值</span>
          <el-slider
            v-model="threshold" :min="0.5" :max="1" :step="0.01"
            style="width: 140px" size="small"
          />
          <b style="font-size: 12px; width: 34px">{{ threshold.toFixed(2) }}</b>
        </div>
        <el-select v-model="topK" size="small" style="width: 128px">
          <el-option :value="0" label="关联不截断" />
          <el-option v-for="k in [3, 4, 6, 8]" :key="k" :value="k" :label="`每节点前${k}强`" />
        </el-select>
        <el-select v-model="repulsion" size="small" style="width: 106px">
          <el-option :value="150" label="布局: 紧凑" />
          <el-option :value="350" label="布局: 适中" />
          <el-option :value="800" label="布局: 松散" />
        </el-select>
        <el-select v-model="labelMode" size="small" style="width: 106px">
          <el-option value="all" label="全部标签" />
          <el-option value="key" label="重点标签" />
          <el-option value="none" label="隐藏标签" />
        </el-select>
        <div style="display: flex; align-items: center; gap: 6px">
          <span style="font-size: 12px; color: var(--el-text-color-secondary)">完整文件名</span>
          <el-switch v-model="showFullNames" size="small" />
        </div>
      </div>
    </div>

    <div style="display: flex; gap: 12px; align-items: stretch; flex: 1; min-height: 0">
      <el-card
        shadow="never" style="flex: 1; min-width: 0; height: 100%; overflow: hidden"
        :body-style="{ padding: '0', height: '100%' }" v-loading="loading"
      >
        <div ref="containerRef" style="width: 100%; height: 100%" />
      </el-card>

      <!-- 关联面板常驻固定宽度：点击锁定后展示 -->
      <el-card
        shadow="never"
        style="width: 380px; flex-shrink: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden"
        :body-style="{ padding: '12px 16px', flex: '1', minHeight: '0', overflowY: 'auto' }"
      >
        <template #header>
          <div style="display: flex; justify-content: space-between; align-items: center">
            <b style="font-size: 14px" class="ellipsis-title">{{ selectedNode?.title ?? '关联文档' }}</b>
            <el-button v-if="selectedNode" size="small" link @click="deselect">关闭</el-button>
          </div>
        </template>
        <template v-if="!selectedNode">
          <el-empty description="点击节点锁定并查看关联；滚轮缩放 / 拖拽平移 / 拖动节点微调布局" :image-size="60" />
        </template>
        <template v-else>
          <p style="margin: 0 0 12px; font-size: 12px; color: var(--el-text-color-secondary)">
            {{ catName(selectedNode.doc_type || 'other') }} · v{{ selectedNode.version_no }} · 关联 {{ relatedItems.length }} 篇
          </p>
          <el-empty v-if="!relatedItems.length" description="该文档暂无关联文档" :image-size="60" />
          <div v-for="item in relatedItems" :key="item.node.id" style="margin-bottom: 14px">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <el-button link type="primary" style="font-size: 13px" @click="$router.push(`/doc/${item.node.id}`)">
                {{ item.node.title }}
              </el-button>
              <el-tag size="small" :type="item.edge.type === 'manual' ? 'warning' : 'success'">
                {{ item.edge.score.toFixed(2) }}
              </el-tag>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px">
              <span style="font-size: 12px; color: var(--el-text-color-secondary)">{{ item.edge.reason }}</span>
              <el-button size="small" link @click="toggleExpand(item)">
                {{ item.expanded ? '收起内容' : '展开内容' }}
              </el-button>
            </div>
            <p
              v-if="item.expanded"
              v-loading="item.previewLoading"
              style="margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--el-text-color-regular); background: var(--el-fill-color-light); padding: 6px 8px; border-radius: 4px; min-height: 24px"
            >{{ item.previewLoading ? '' : item.preview + '…' }}</p>
          </div>
        </template>
      </el-card>
    </div>

    <div style="margin-top: 8px; font-size: 12px; color: var(--el-text-color-secondary); flex-shrink: 0">
      图例：<span style="color: #409eff">━</span> 自动关联（颜色随源节点分类）
      <span style="color: #e6a23c; margin-left: 12px">━</span> 手动关联；
      节点颜色/大小 = 文档分类 / 关联数量；标签始终外置不遮挡节点，重叠自动互让；
      滚轮缩放 / 空白拖拽平移 / 拖动节点微调；悬浮自动聚焦邻居，点击图例过滤分类。
    </div>
  </div>
</template>
