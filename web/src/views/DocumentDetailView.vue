<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { diffLines } from 'diff';
import { marked } from 'marked';
import PageHeader from '../components/PageHeader.vue';
import { api, type DocumentFull, type VersionSummary } from '../api';

interface RelatedDoc { document_id: string; title: string; score: number; reason: string }

const route = useRoute();
const docId = route.params.id as string;

const doc = ref<DocumentFull | null>(null);
const versions = ref<VersionSummary[]>([]);
const related = ref<RelatedDoc[]>([]);
const activeTab = ref('content');
const viewingVersion = ref<number | null>(null); // null = 最新版
const versionContent = ref('');
const loading = ref(false);

// 编辑
const editing = ref(false);
const editContent = ref('');
const editNote = ref('');

// 对比（默认最新版 vs 上一版）
const compareA = ref<number>();
const compareB = ref<number>();
const diffParts = ref<{ value: string; added: boolean; removed: boolean }[]>([]);

const contentShown = computed(() => (viewingVersion.value === null ? doc.value?.content ?? '' : versionContent.value));

// markdown 内置预览：默认渲染视图，可切原文
const viewMode = ref<'preview' | 'source'>('preview');
const renderedMd = computed(() => marked.parse(contentShown.value, { async: false }) as string);

async function loadDoc(version?: number) {
  loading.value = true;
  try {
    const path = version ? `/api/documents/${docId}?version=${version}` : `/api/documents/${docId}`;
    const d = await api<DocumentFull>('GET', path);
    doc.value = doc.value ? { ...doc.value, ...d } : d;
    viewingVersion.value = version ?? null;
    if (version) versionContent.value = d.content;
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function loadVersions() {
  versions.value = await api<VersionSummary[]>('GET', `/api/documents/${docId}/versions`);
  if (versions.value.length >= 2) {
    compareA.value = versions.value[0].version_no;
    compareB.value = versions.value[1].version_no;
  }
}

function runCompare() {
  if (!compareA.value || !compareB.value) return ElMessage.warning('请选择两个要对比的版本');
  if (compareA.value === compareB.value) return ElMessage.warning('两个版本相同');
  Promise.all([
    api<DocumentFull>('GET', `/api/documents/${docId}?version=${compareA.value}`),
    api<DocumentFull>('GET', `/api/documents/${docId}?version=${compareB.value}`),
  ]).then(([a, b]) => {
    diffParts.value = diffLines(b.content, a.content); // 旧 → 新
    if (!diffParts.value.length) diffParts.value = [{ value: '（两版内容一致）', added: false, removed: false }];
  }).catch((e) => ElMessage.error((e as Error).message));
}

function startEdit() {
  editContent.value = doc.value?.content ?? '';
  editNote.value = '';
  editing.value = true;
}

/** 导出下载（服务端 Content-Disposition 附件；查看历史版本时带版本号） */
function downloadDoc() {
  const suffix = viewingVersion.value ? `?version=${viewingVersion.value}` : '';
  window.open(`/api/documents/${docId}/export${suffix}`);
}

async function saveEdit() {
  try {
    const r = await api<{ version_no: number; chunk_count: number; vectors_reused: number }>(
      'PUT', `/api/documents/${docId}`, { content: editContent.value, changeNote: editNote.value || 'Web 更新' },
    );
    ElMessage.success(`已保存 v${r.version_no}（${r.chunk_count} 块，复用向量 ${r.vectors_reused}）`);
    editing.value = false;
    await Promise.all([loadDoc(), loadVersions()]);
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

onMounted(() => {
  loadDoc();
  loadVersions();
  // P4：自动关联文档（静默加载，无关联不展示）
  api<{ related: RelatedDoc[] }>('GET', `/api/documents/${docId}/links`)
    .then((r) => { related.value = r.related; })
    .catch(() => { /* 关联查询失败不打断页面 */ });
});
</script>

<template>
  <div style="padding: 20px" v-loading="loading">
    <PageHeader
      :title="doc?.title ?? '…'"
      :params="doc ? { projectId: doc.project_id } : undefined"
    >
      <template #title-extra>
        <el-tag size="small">v{{ viewingVersion ?? doc?.version_no }}</el-tag>
        <el-tag v-if="viewingVersion" size="small" type="warning">历史版本只读</el-tag>
      </template>
      <el-button v-if="!editing" @click="downloadDoc">下载 .md</el-button>
      <el-button v-if="!editing && viewingVersion === null" type="primary" @click="startEdit">编辑</el-button>
    </PageHeader>

    <p class="page-body" style="margin-bottom: 16px; color: var(--el-text-color-secondary); font-size: 13px">
      变更说明：{{ doc?.change_note || '—' }} · 更新于 {{ doc ? new Date(doc.updated_at).toLocaleString() : '' }}
    </p>

    <el-alert
      v-if="related.length && !editing && viewingVersion === null"
      type="warning" :closable="false" style="margin-bottom: 16px"
    >
      <template #title>
        关联文档（需求变更时建议检查同步）：
        <el-button
          v-for="r in related" :key="r.document_id"
          link type="primary" @click="$router.push(`/doc/${r.document_id}`)"
        >{{ r.title }}（{{ r.score.toFixed(2) }}）</el-button>
      </template>
    </el-alert>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="内容" name="content">
        <template v-if="editing">
          <el-input v-model="editNote" placeholder="变更说明（可选）" style="margin-bottom: 8px" />
          <el-input v-model="editContent" type="textarea" :rows="22" />
          <div style="margin-top: 10px">
            <el-button @click="editing = false">取消</el-button>
            <el-button type="primary" @click="saveEdit">保存（追加新版本）</el-button>
          </div>
        </template>
        <template v-else>
          <el-radio-group v-model="viewMode" size="small" style="margin-bottom: 10px">
            <el-radio-button value="preview">预览</el-radio-button>
            <el-radio-button value="source">原文</el-radio-button>
          </el-radio-group>
          <div
            v-if="viewMode === 'preview'"
            class="md-body"
            style="background: #fff; padding: 20px 24px; border-radius: 10px; border: 1px solid var(--app-border); min-height: 200px"
            v-html="renderedMd"
          />
          <pre
            v-else
            style="white-space: pre-wrap; background: #fff; padding: 20px 24px; border-radius: 10px; border: 1px solid var(--app-border); font-family: inherit; line-height: 1.7"
          >{{ contentShown }}</pre>
        </template>
      </el-tab-pane>

      <el-tab-pane :label="`版本历史（${versions.length}）`" name="versions">
        <el-timeline style="margin-top: 8px">
          <el-timeline-item
            v-for="v in versions" :key="v.version_no"
            :type="v.version_no === doc?.version_no ? 'primary' : undefined"
            :timestamp="`${new Date(v.created_at).toLocaleString()} · by ${v.created_by}`"
          >
            <b>v{{ v.version_no }}</b> — {{ v.change_note || '（无说明）' }}
            <el-button size="small" link type="primary" @click="activeTab = 'content'; loadDoc(v.version_no)">查看</el-button>
          </el-timeline-item>
        </el-timeline>

        <el-divider>版本对比（A ← B）</el-divider>
        <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 12px">
          <span>旧版</span>
          <el-select v-model="compareB" style="width: 100px" placeholder="旧版">
            <el-option v-for="v in versions" :key="v.version_no" :label="'v' + v.version_no" :value="v.version_no" />
          </el-select>
          <span>→ 新版</span>
          <el-select v-model="compareA" style="width: 100px" placeholder="新版">
            <el-option v-for="v in versions" :key="v.version_no" :label="'v' + v.version_no" :value="v.version_no" />
          </el-select>
          <el-button type="primary" @click="runCompare">对比</el-button>
        </div>
        <div
          v-if="diffParts.length"
          style="background: #fff; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; padding: 12px; font-family: monospace; font-size: 13px"
        >
          <div
            v-for="(p, i) in diffParts" :key="i"
            :style="{
              whiteSpace: 'pre-wrap',
              background: p.added ? '#e6ffed' : p.removed ? '#ffeef0' : 'transparent',
              color: p.added ? '#22863a' : p.removed ? '#cb2431' : 'inherit',
            }"
          >{{ p.added ? '+ ' : p.removed ? '- ' : '  ' }}{{ p.value }}</div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
