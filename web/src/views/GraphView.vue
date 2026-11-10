<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Refresh, Connection } from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import { api, type DocCategory, type DocumentFull } from '../api';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';

/** 与后端 projectGraph 返回结构对应 */
interface GraphNode {
  id: string; title: string; source_type: string; doc_type: string;
  version_no: number; updated_at: string; link_count: number;
}
interface GraphEdge { source_id: string; target_id: string; type: string; score: number; reason: string }

/** 3D 图节点对象（持久持有：过滤切换时保留坐标，避免整图重排） */
interface Node3D extends GraphNode { color: string; val: number; x: number; y: number; z: number }

const route = useRoute();
const projectId = route.params.id as string;

const nodes = ref<GraphNode[]>([]);
const edges = ref<GraphEdge[]>([]);
const categories = ref<DocCategory[]>([]);
const loading = ref(false);
/** 点击锁定的选中节点；再次点击取消 */
const selectedId = ref<string | null>(null);
/** 悬浮预览的节点（无锁定选中时生效） */
const hoverId = ref<string | null>(null);
/** 当前生效的高亮节点：点击锁定优先，否则跟随悬浮 */
const activeId = computed(() => selectedId.value ?? hoverId.value);
/** 相似度阈值：低于该值的弱关联边默认隐藏 */
const threshold = ref(0.85);
/** 每节点最多显示的最强关联数；0 = 不限（边降噪核心手段） */
const topK = ref(4);
/** 标签显示模式：key=重点节点（Top 关联数/锁定） all=全部 none=隐藏 */
const labelMode = ref<'key' | 'all' | 'none'>('key');
/** 完整文件名开关：关闭时截断 12 字 */
const showFullNames = ref(false);
/** 隐藏的分类 id 列表（图例点击过滤） */
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

/** 悬浮/锁定节点的可见邻居集合（用于淡化非邻居与边高亮） */
const neighborIds = ref<Set<string>>(new Set());
function rebuildNeighbors(id: string | null) {
  const set = new Set<string>();
  if (id) {
    for (const e of shownEdges.value) {
      if (e.source_id === id) set.add(e.target_id);
      else if (e.target_id === id) set.add(e.source_id);
    }
  }
  neighborIds.value = set;
}

const relatedCount = computed(() => edges.value.length);

// ---------- 高亮联动：activeId 变化即重建右侧关联面板（悬浮预览 / 点击锁定共用） ----------
watch(activeId, (id) => {
  rebuildNeighbors(id);
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

// ---------- 3D 图（3d-force-graph + three） ----------
const containerRef = ref<HTMLDivElement | null>(null);
let graph: any = null;
let resizeOb: ResizeObserver | null = null;
let nodeObjs: Node3D[] = [];
let needFit = false;
/** 分类聚簇引力中心（斐波那契球面分布） */
let catCenters: Record<string, { x: number; y: number; z: number }> = {};

const NODE_REL_SIZE = 3;
const radiusOf = (val: number) => Math.cbrt(Math.max(0, val)) * NODE_REL_SIZE;

/** d3 在模拟初始化后会把 link.source/target 替换为节点对象，取 id 时兼容两种形态 */
const nid = (s: any) => (typeof s === 'object' && s !== null ? s.id : s);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

// ---- 访问器（读取当前响应式状态；状态变化后重新 setter 触发刷新） ----
const nodeColorFn = (n: Node3D) => {
  const base = n.id === selectedId.value ? '#f56c6c' : n.color;
  if (!activeId.value) return base;
  return n.id === activeId.value || neighborIds.value.has(n.id) ? base : dimHex(base, 0.12);
};
const isLinkActive = (l: any) =>
  !activeId.value || nid(l.source) === activeId.value || nid(l.target) === activeId.value;
const linkColorFn = (l: any) => {
  if (activeId.value) return isLinkActive(l) ? (l.type === 'manual' ? '#e6a23c' : '#409eff') : '#909399';
  return l.type === 'manual' ? '#e6a23c' : '#409eff';
};
const linkOpacityFn = (l: any) =>
  activeId.value ? (isLinkActive(l) ? 0.85 : 0.03) : 0.1 + l.score * 0.35;
const linkWidthFn = (l: any) =>
  activeId.value ? (isLinkActive(l) ? 3 : 0.4) : 0.5 + l.score * 1.2;

/** hex → rgba 淡化 */
function dimHex(hex: string, alpha: number) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 重点节点：关联数 Top15 + 锁定节点 */
const topDegreeIds = computed(() =>
  new Set([...nodes.value].sort((a, b) => b.link_count - a.link_count).slice(0, 15).map((n) => n.id)),
);
const showLabel = (n: Node3D) =>
  labelMode.value === 'all'
  || (labelMode.value === 'key' && (topDegreeIds.value.has(n.id) || n.id === selectedId.value));

/** 标签精灵：canvas 文字纹理，挂在默认球体下方（nodeThreeObjectExtend 模式） */
function makeLabelSprite(n: Node3D): THREE.Object3D {
  if (!showLabel(n)) return new THREE.Object3D();
  const full = showFullNames.value || n.id === selectedId.value;
  const text = full ? n.title : (n.title.length > 12 ? n.title.slice(0, 11) + '…' : n.title);
  const fontSize = 64;
  const canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d')!;
  const font = `${fontSize}px "Microsoft YaHei", sans-serif`;
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 24;
  canvas.height = Math.round(fontSize * 1.5);
  ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = n.id === selectedId.value ? '#f56c6c' : 'rgba(48, 49, 51, 0.95)';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  const s = 0.09;
  sprite.scale.set(canvas.width * s, canvas.height * s, 1);
  sprite.position.set(0, -(radiusOf(n.val) + 2.6), 0);
  return sprite;
}

/** 悬浮 HTML 提示 */
const nodeTooltip = (n: Node3D) => `
  <div style="max-width:320px;padding:8px 10px;border-radius:6px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.18);font-size:12px;color:#303133">
    <b>${escapeHtml(n.title)}</b><br/>
    <span style="color:#909399">${escapeHtml(catName(n.doc_type))} · v${n.version_no} · 关联 ${n.link_count} 篇 · 点击锁定</span>
  </div>`;

/** 分类引力中心：按分类节点数降序，斐波那契球面分布 */
function computeCenters() {
  const counts = new Map<string, number>();
  for (const n of nodeObjs) counts.set(n.doc_type, (counts.get(n.doc_type) ?? 0) + 1);
  const catList = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  catCenters = {};
  const R = 180;
  catList.forEach((c, i) => {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / catList.length);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    catCenters[c] = {
      x: R * Math.sin(phi) * Math.cos(theta),
      y: R * Math.sin(phi) * Math.sin(theta),
      z: R * Math.cos(phi),
    };
  });
}

function initGraph() {
  const el = containerRef.value;
  if (!el || graph) return;
  graph = ForceGraph3D()(el)
    .backgroundColor('#fafbfd')
    .showNavInfo(false)
    .nodeRelSize(NODE_REL_SIZE)
    .nodeVal((n: Node3D) => n.val)
    .nodeColor(nodeColorFn)
    .nodeLabel(nodeTooltip)
    .nodeThreeObjectExtend(true)
    .nodeThreeObject(makeLabelSprite)
    .linkColor(linkColorFn)
    .linkOpacity(linkOpacityFn)
    .linkWidth(linkWidthFn)
    .onNodeHover((n: Node3D | null) => { hoverId.value = n?.id ?? null; })
    .onNodeClick((n: Node3D) => {
      selectedId.value = selectedId.value === n.id ? null : n.id;
    })
    .onBackgroundClick(() => deselect())
    .onEngineStop(() => {
      if (needFit) {
        needFit = false;
        graph.zoomToFit(500, 60);
      }
    });
  graph.d3Force('charge')?.strength(-110);
  graph.d3Force('link')?.distance(60);
  // 分类聚簇力：节点向各自分类中心持续微拉（与关联弹簧力共同作用）
  graph.d3Force('cluster', (alpha: number) => {
    for (const n of graph.graphData().nodes as Node3D[]) {
      const c = catCenters[n.doc_type];
      if (!c) continue;
      n.vx += (c.x - n.x) * alpha * 2;
      n.vy += (c.y - n.y) * alpha * 2;
      n.vz += (c.z - n.z) * alpha * 2;
    }
  });
  graph.width(el.clientWidth || 800).height(el.clientHeight || 600);
  resizeOb = new ResizeObserver(() => {
    if (!graph || !containerRef.value) return;
    graph.width(containerRef.value.clientWidth || 800).height(containerRef.value.clientHeight || 600);
  });
  resizeOb.observe(el);
}

function refreshAppearance() {
  if (!graph) return;
  graph.nodeColor(nodeColorFn);
  graph.linkColor(linkColorFn);
  graph.linkOpacity(linkOpacityFn);
  graph.linkWidth(linkWidthFn);
}

function refreshLabels() {
  if (!graph) return;
  graph.nodeThreeObject(makeLabelSprite);
}

/** 依据当前过滤条件重建图数据（节点对象持久复用 → 坐标保留） */
function rebuildGraph() {
  if (!graph) return;
  const vis = nodeObjs.filter((n) => !hiddenCats.value.includes(n.doc_type));
  const visIds = new Set(vis.map((n) => n.id));
  const links = shownEdges.value
    .filter((e) => visIds.has(e.source_id) && visIds.has(e.target_id))
    .map((e) => ({ source: e.source_id, target: e.target_id, score: e.score, type: e.type, reason: e.reason }));
  graph.graphData({ nodes: vis, links });
  needFit = true;
  graph.d3ReheatSimulation();
}

watch(activeId, () => refreshAppearance());
watch(selectedId, () => refreshLabels());
watch([threshold, topK], () => rebuildGraph());
watch(labelMode, () => refreshLabels());
watch(showFullNames, () => refreshLabels());
watch(hiddenCats, () => rebuildGraph());

function deselect() {
  selectedId.value = null;
  hoverId.value = null;
}

// ---------- 分类图例过滤 ----------
interface LegendItem { id: string; name: string; color: string; count: number }
const legendItems = computed<LegendItem[]>(() => {
  const counts = new Map<string, number>();
  for (const n of nodes.value) {
    const c = n.doc_type || 'other';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count, name: catName(id), color: catColor(id) }));
});

function toggleCat(id: string) {
  const i = hiddenCats.value.indexOf(id);
  hiddenCats.value = i >= 0
    ? hiddenCats.value.filter((c) => c !== id)
    : [...hiddenCats.value, id];
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
    // 构建持久节点对象（颜色/尺寸/初始位置：分类中心附近散布）
    nodeObjs = nodes.value.map((n) => ({
      ...n,
      color: catColor(n.doc_type),
      val: 2 + Math.min(n.link_count * 1.2, 40),
      x: 0, y: 0, z: 0,
    }));
    computeCenters();
    nodeObjs.forEach((n) => {
      const c = catCenters[n.doc_type] ?? { x: 0, y: 0, z: 0 };
      n.x = c.x + (Math.random() - 0.5) * 90;
      n.y = c.y + (Math.random() - 0.5) * 90;
      n.z = c.z + (Math.random() - 0.5) * 90;
    });
    initGraph();
    rebuildGraph();
    if (!g.nodes.length) ElMessage.info('项目暂无文档');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

/** 重新布局：重掷初始位置（围绕分类中心）并重新模拟 */
function relayout() {
  nodeObjs.forEach((n) => {
    const c = catCenters[n.doc_type] ?? { x: 0, y: 0, z: 0 };
    n.x = c.x + (Math.random() - 0.5) * 110;
    n.y = c.y + (Math.random() - 0.5) * 110;
    n.z = c.z + (Math.random() - 0.5) * 110;
  });
  rebuildGraph();
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
  if (graph) {
    try { graph._destructor(); } catch { /* 忽略销毁异常 */ }
    graph = null;
  }
});
</script>

<template>
  <!-- 整页适配视口高度：头部/图例固定，中间区域弹性占满，内部各自滚动 -->
  <div style="height: 100%; padding: 20px; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden">
    <PageHeader title="关联拓扑（3D）" style="flex-shrink: 0">
      <el-button :icon="Connection" :loading="rebuilding" @click="rebuildLinks">重建关联</el-button>
      <el-button :icon="Refresh" @click="relayout">重新布局</el-button>
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
        <el-select v-model="labelMode" size="small" style="width: 106px">
          <el-option value="key" label="重点标签" />
          <el-option value="all" label="全部标签" />
          <el-option value="none" label="隐藏标签" />
        </el-select>
        <div style="display: flex; align-items: center; gap: 6px">
          <span style="font-size: 12px; color: var(--el-text-color-secondary)">完整文件名</span>
          <el-switch v-model="showFullNames" size="small" />
        </div>
      </div>
    </div>

    <!-- 分类图例过滤：点击隐藏/显示对应分类节点 -->
    <div
      v-if="legendItems.length"
      style="flex-shrink: 0; margin-bottom: 10px; display: flex; gap: 14px; flex-wrap: wrap; align-items: center"
    >
      <span style="font-size: 12px; color: var(--el-text-color-secondary)">分类（点击过滤）:</span>
      <span
        v-for="c in legendItems" :key="c.id"
        style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; user-select: none"
        :style="{ color: hiddenCats.includes(c.id) ? 'var(--el-text-color-placeholder)' : 'var(--el-text-color-regular)' }"
        @click="toggleCat(c.id)"
      >
        <span
          :style="{
            width: '10px', height: '10px', borderRadius: '50%', display: 'inline-block',
            background: c.color, opacity: hiddenCats.includes(c.id) ? 0.3 : 0.9,
          }"
        />
        {{ c.name }}（{{ c.count }}）
      </span>
    </div>

    <div style="display: flex; gap: 12px; align-items: stretch; flex: 1; min-height: 0">
      <el-card
        shadow="never" style="flex: 1; min-width: 0; height: 100%; overflow: hidden"
        :body-style="{ padding: '0', height: '100%' }" v-loading="loading"
      >
        <div ref="containerRef" style="width: 100%; height: 100%" />
      </el-card>

      <!-- 关联面板常驻固定宽度：悬浮/点击锁定共用 -->
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
          <el-empty description="悬浮节点预览关联，点击锁定；左键旋转 / 滚轮缩放 / 右键平移" :image-size="60" />
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
      图例：<span style="color: #409eff">━</span> 自动关联（向量相似）
      <span style="color: #e6a23c; margin-left: 12px">━</span> 手动关联
      节点颜色 = 文档分类（同色聚簇）；节点大小 = 关联数量；
      鼠标左键旋转 / 滚轮缩放 / 右键平移；悬浮聚焦邻居 / 点击锁定；「每节点前 K 强」+ 阈值滑杆可逐步降噪。
    </div>
  </div>
</template>
