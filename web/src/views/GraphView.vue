<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Refresh, Connection } from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import { api, type DocCategory, type DocumentFull } from '../api';

/** 与后端 projectGraph 返回结构对应 */
interface GraphNode {
  id: string; title: string; source_type: string; doc_type: string;
  version_no: number; updated_at: string; link_count: number;
}
interface GraphEdge { source_id: string; target_id: string; type: string; score: number; reason: string }

/** 模拟布局中的节点（含坐标与速度） */
interface SimNode extends GraphNode { x: number; y: number; vx: number; vy: number }

const route = useRoute();
const projectId = route.params.id as string;

const W = 1100, H = 760;
const nodes = ref<SimNode[]>([]);
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
/** 标签显示模式：key=重点节点（Top 关联数/悬浮/邻居） all=全部 none=隐藏 */
const labelMode = ref<'key' | 'all' | 'none'>('key');
/** 完整文件名开关：关闭时截断 12 字，悬浮/关联节点始终完整 */
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
/** 分类显示名；未知分类回退"未分类" */
const catName = (t: string) => catOf(t)?.name ?? FALLBACK_NAME;
/** 分类色：hex 直用，预设枚举映射 hex，未知分类取兜底色板 */
const catColor = (t: string) => {
  const c = catOf(t);
  if (!c) return FALLBACK_PALETTE[0];
  if (c.color.startsWith('#')) return c.color;
  return PRESET_HEX[c.color] ?? '#909399';
};
const nodeCat = (n: SimNode) => n.doc_type || 'other';

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

/** 可见节点（图例过滤掉被隐藏分类） */
const visibleNodes = computed(() => nodes.value.filter((n) => !hiddenCats.value.includes(nodeCat(n))));
const visibleIds = computed(() => new Set(visibleNodes.value.map((n) => n.id)));

interface RelatedItem {
  node: SimNode;
  edge: GraphEdge;
  preview: string;
  previewLoading: boolean;
  /** 内容默认折叠，点击展开时才拉取 */
  expanded: boolean;
}
const relatedItems = ref<RelatedItem[]>([]);

const selectedNode = computed(() => nodes.value.find((n) => n.id === activeId.value) ?? null);

const nodeById = computed(() => new Map(nodes.value.map((n) => [n.id, n])));

/** 边渲染数据（含坐标）：两端节点都可见才绘制 */
const edgeLines = computed(() =>
  shownEdges.value
    .map((e) => {
      if (!visibleIds.value.has(e.source_id) || !visibleIds.value.has(e.target_id)) return null;
      const s = nodeById.value.get(e.source_id);
      const t = nodeById.value.get(e.target_id);
      if (!s || !t) return null;
      const active = !activeId.value || e.source_id === activeId.value || e.target_id === activeId.value;
      return { ...e, x1: s.x, y1: s.y, x2: t.x, y2: t.y, active };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null),
);

const edgeColor = (type: string) => (type === 'manual' ? '#e6a23c' : '#409eff');
const edgeOpacity = (e: { score: number; active: boolean }) =>
  activeId.value ? (e.active ? 0.85 : 0.05) : 0.1 + e.score * 0.4;

/** 曲线边：二次贝塞尔（弧度代替直线，减少交叉重叠感） */
const edgePath = (e: { x1: number; y1: number; x2: number; y2: number }) => {
  const mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2;
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
  return `M${e.x1},${e.y1} Q${mx - dy * 0.15},${my + dx * 0.15} ${e.x2},${e.y2}`;
};

const nodeRadius = (n: SimNode) => Math.min(7 + n.link_count * 1.2, 16);
/** 节点色 = 分类色；聚焦时邻居保持分类色、其余淡化 */
const nodeFill = (n: SimNode) => (n.id === activeId.value ? '#f56c6c' : catColor(nodeCat(n)));
const nodeOpacity = (n: SimNode) =>
  !activeId.value ? 0.92 : n.id === activeId.value || isConnectedTo(n.id) ? 1 : 0.15;

function isConnectedTo(id: string): boolean {
  if (!activeId.value) return false;
  return shownEdges.value.some(
    (e) => (e.source_id === activeId.value && e.target_id === id)
        || (e.target_id === activeId.value && e.source_id === id),
  );
}

/** 重点节点：关联数 Top15（聚簇布局下标签仍然稀缺，只标注枢纽节点） */
const topDegreeIds = computed(() =>
  new Set([...nodes.value].sort((a, b) => b.link_count - a.link_count).slice(0, 15).map((n) => n.id)),
);
const showLabel = (n: SimNode) =>
  labelMode.value === 'all'
  || (labelMode.value === 'key'
    && (n.id === activeId.value || isConnectedTo(n.id) || topDegreeIds.value.has(n.id)));

/** 节点标签：完整名开关关闭时截断 12 字；当前高亮/关联节点始终完整 */
const label = (n: SimNode) =>
  showFullNames.value || n.id === activeId.value || isConnectedTo(n.id)
    ? n.title
    : (n.title.length > 12 ? n.title.slice(0, 11) + '…' : n.title);

// ---------- 高亮联动：activeId 变化即重建右侧关联面板（悬浮预览 / 点击锁定共用） ----------
watch(activeId, (id) => {
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

/** 点击节点：已锁定则取消，否则锁定（拖拽后不触发） */
function toggleSelect(node: SimNode) {
  if (dragMoved) return;
  selectedId.value = selectedId.value === node.id ? null : node.id;
}

// ---------- 分类图例过滤 ----------
interface LegendItem { id: string; name: string; color: string; count: number }
const legendItems = computed<LegendItem[]>(() => {
  const counts = new Map<string, number>();
  for (const n of nodes.value) {
    const c = nodeCat(n);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count, name: catName(id), color: catColor(id) }));
});

function toggleCat(id: string) {
  const i = hiddenCats.value.indexOf(id);
  if (i >= 0) hiddenCats.value.splice(i, 1);
  else hiddenCats.value.push(id);
}

// ---------- 节点拖拽：手动整理布局 ----------
const svgRef = ref<SVGSVGElement | null>(null);
let dragNode: SimNode | null = null;
let dragMoved = false;

/** 屏幕坐标 → viewBox 坐标（preserveAspectRatio meet 含留白换算） */
function toSvgPoint(evt: MouseEvent): { x: number; y: number } | null {
  const svg = svgRef.value;
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const scale = Math.min(rect.width / W, rect.height / H);
  const ox = (rect.width - W * scale) / 2;
  const oy = (rect.height - H * scale) / 2;
  return { x: (evt.clientX - rect.left - ox) / scale, y: (evt.clientY - rect.top - oy) / scale };
}

function onNodeDown(node: SimNode, evt: MouseEvent) {
  dragNode = node;
  dragMoved = false;
  evt.preventDefault();
}

function onSvgMove(evt: MouseEvent) {
  if (!dragNode) return;
  const p = toSvgPoint(evt);
  if (!p) return;
  dragMoved = true;
  dragNode.x = Math.max(60, Math.min(W - 60, p.x));
  dragNode.y = Math.max(40, Math.min(H - 40, p.y - 14));
  dragNode.vx = 0;
  dragNode.vy = 0;
}

function onSvgUp() {
  dragNode = null;
}

// ---------- 力导向布局（分类聚簇版）：同分类节点向自己的"分类引力中心"聚拢 ----------
function layout(seedJitter = false) {
  const n = nodes.value.length;
  if (!n) return;

  // 每个分类一个虚拟引力中心：按分类节点数降序环形排布 → 形成色彩分区
  const catList = [...legendItems.value.map((l) => l.id)];
  if (!catList.includes('other') && nodes.value.some((nd) => nodeCat(nd) === 'other')) catList.push('other');
  const R = Math.min(W, H) * 0.30;
  const centers = new Map<string, { x: number; y: number }>();
  catList.forEach((c, i) => {
    const angle = (2 * Math.PI * i) / catList.length - Math.PI / 2;
    centers.set(c, { x: W / 2 + R * Math.cos(angle), y: H / 2 + R * 0.75 * Math.sin(angle) });
  });

  // 初始位置：围绕各自分类中心散布（抖动避免完全对称）
  const perCatIdx = new Map<string, number>();
  nodes.value.forEach((node) => {
    const c = nodeCat(node);
    const k = perCatIdx.get(c) ?? 0;
    perCatIdx.set(c, k + 1);
    const center = centers.get(c) ?? { x: W / 2, y: H / 2 };
    const angle = (2 * Math.PI * k) / 8 + (k % 3) * 0.9;
    const r = 30 + (k % 5) * 22 + (seedJitter ? Math.random() * 30 : 0);
    node.x = Math.max(50, Math.min(W - 50, center.x + r * Math.cos(angle)));
    node.y = Math.max(40, Math.min(H - 40, center.y + r * 0.8 * Math.sin(angle)));
    node.vx = 0; node.vy = 0;
  });

  const repulsion = 36000;      // 节点间斥力
  const spring = 0.012;         // 关联边弹簧刚度
  const restLen = 170;          // 关联边理想长度
  const clusterGravity = 0.05;  // 向各自分类中心的引力（聚簇强度）
  const damping = 0.85;

  for (let iter = 0; iter < 300; iter++) {
    for (let i = 0; i < n; i++) {
      const a = nodes.value[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes.value[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = repulsion / (dist * dist);
        dx /= dist; dy /= dist;
        a.vx += dx * force; a.vy += dy * force;
        b.vx -= dx * force; b.vy -= dy * force;
      }
    }
    // 相关节点互相吸引（弹簧）
    for (const e of shownEdges.value) {
      const s = nodeById.value.get(e.source_id);
      const t = nodeById.value.get(e.target_id);
      if (!s || !t) continue;
      const dx = t.x - s.x, dy = t.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = spring * (dist - restLen);
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      s.vx += fx; s.vy += fy;
      t.vx -= fx; t.vy -= fy;
    }
    for (const node of nodes.value) {
      const center = centers.get(nodeCat(node)) ?? { x: W / 2, y: H / 2 };
      node.vx += (center.x - node.x) * clusterGravity;
      node.vy += (center.y - node.y) * clusterGravity;
      node.vx *= damping; node.vy *= damping;
      node.x = Math.max(50, Math.min(W - 50, node.x + node.vx));
      node.y = Math.max(40, Math.min(H - 40, node.y + node.vy));
    }
  }
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

function deselect() {
  selectedId.value = null;
  hoverId.value = null;
}

async function load(seedJitter = false) {
  loading.value = true;
  deselect();
  try {
    const [g, cats] = await Promise.all([
      api<{ nodes: GraphNode[]; edges: GraphEdge[] }>('GET', `/api/projects/${projectId}/graph`),
      api<{ items: DocCategory[] }>('GET', '/api/doc-categories'),
    ]);
    categories.value = cats.items;
    edges.value = g.edges;
    nodes.value = g.nodes.map((n) => ({ ...n, doc_type: n.doc_type || 'other', x: 0, y: 0, vx: 0, vy: 0 }));
    hiddenCats.value = [];
    layout(seedJitter);
    if (!g.nodes.length) ElMessage.info('项目暂无文档');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

const relatedCount = computed(() => edges.value.length);

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
</script>

<template>
  <!-- 整页适配视口高度：头部/图例固定，中间区域弹性占满，内部各自滚动 -->
  <div style="height: 100%; padding: 20px; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden">
    <PageHeader title="关联拓扑" style="flex-shrink: 0">
      <el-button :icon="Connection" :loading="rebuilding" @click="rebuildLinks">重建关联</el-button>
      <el-button :icon="Refresh" @click="load(true)">重新布局</el-button>
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
        <svg
          ref="svgRef"
          :viewBox="`0 0 ${W} ${H}`" style="width: 100%; height: 100%; display: block; background: #fafbfd"
          preserveAspectRatio="xMidYMid meet"
          @click.self="deselect"
          @mousemove="onSvgMove"
          @mouseup="onSvgUp"
          @mouseleave="onSvgUp"
        >
          <!-- 关联边（曲线，弧度减少交叉重叠感） -->
          <path
            v-for="(e, i) in edgeLines" :key="`e${i}`"
            :d="edgePath(e)" fill="none"
            :stroke="edgeColor(e.type)" :stroke-opacity="edgeOpacity(e)"
            :stroke-width="activeId ? (e.active ? 1.5 + e.score * 2 : 1) : 1 + e.score * 2"
          >
            <title>{{ e.reason }}</title>
          </path>
          <!-- 节点：分类着色聚簇；悬浮预览选中，点击锁定/再点取消，可拖拽整理 -->
          <g
            v-for="n in visibleNodes" :key="n.id"
            style="cursor: pointer"
            @mouseenter="hoverId = n.id"
            @mouseleave="hoverId = null"
            @mousedown="onNodeDown(n, $event)"
            @click.stop="toggleSelect(n)"
          >
            <circle
              :cx="n.x" :cy="n.y" :r="nodeRadius(n)"
              :fill="nodeFill(n)" :fill-opacity="nodeOpacity(n)"
              :stroke="n.id === activeId ? '#f56c6c' : '#fff'"
              :stroke-width="n.id === activeId ? 2.5 : 1.5"
              :stroke-opacity="nodeOpacity(n)"
            />
            <text
              v-if="showLabel(n)"
              :x="n.x" :y="n.y + nodeRadius(n) + 13"
              text-anchor="middle" font-size="11"
              :fill="n.id === activeId ? '#f56c6c' : '#303133'"
              :font-weight="n.id === activeId || isConnectedTo(n.id) ? '700' : '400'"
              :opacity="nodeOpacity(n)"
              style="pointer-events: none"
            >{{ label(n) }}</text>
            <title>{{ catName(nodeCat(n)) }} · {{ n.title }}（关联 {{ n.link_count }} 篇；可拖拽调整位置）</title>
          </g>
        </svg>
      </el-card>

      <!-- 关联面板常驻固定宽度：避免出现/消失引起 SVG 布局抖动（悬浮回环闪烁） -->
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
          <el-empty description="悬浮节点预览关联，点击锁定" :image-size="60" />
        </template>
        <template v-else>
          <p style="margin: 0 0 12px; font-size: 12px; color: var(--el-text-color-secondary)">
            {{ catName(nodeCat(selectedNode)) }} · v{{ selectedNode.version_no }} · 关联 {{ relatedItems.length }} 篇
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
      悬浮聚焦邻居 / 点击锁定 / 拖拽整理；「每节点前 K 强」+ 阈值滑杆可逐步降噪。
    </div>
  </div>
</template>
