<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { UploadRequestOptions } from 'element-plus';
import { Search, Share, Upload } from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import { api, type DocumentListResult, type DocumentSummary, type Project } from '../api';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id as string;

const project = ref<Project | null>(null);
const docs = ref<DocumentSummary[]>([]);
const loading = ref(false);
const uploadRef = ref();
const uploading = ref(false);

// 分类过滤 / 搜索 / 分页状态
const DOC_TYPE_OPTIONS = [
  { value: 'requirement', label: '需求' },
  { value: 'contract', label: '合同' },
  { value: 'adjustment', label: '调整记录' },
  { value: 'tech', label: '技术说明' },
  { value: 'test', label: '测试' },
  { value: 'other', label: '其他' },
] as const;
const activeType = ref<string>('all');
const keywordInput = ref('');
const keyword = ref('');
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const counts = ref<Record<string, number>>({});
let keywordTimer: ReturnType<typeof setTimeout> | null = null;

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

async function load() {
  loading.value = true;
  try {
    const [projects, list] = await Promise.all([
      api<Project[]>('GET', '/api/projects'),
      api<DocumentListResult>('GET',
        `/api/projects/${projectId}/documents`
        + `?page=${page.value}&page_size=${pageSize.value}`
        + (activeType.value !== 'all' ? `&doc_type=${activeType.value}` : '')
        + (keyword.value ? `&keyword=${encodeURIComponent(keyword.value)}` : '')),
    ]);
    project.value = projects.find((p) => p.id === projectId) ?? null;
    docs.value = list.items;
    total.value = list.total;
    counts.value = list.counts;
    // 当前页超出总页数（如删除/过滤后）时回退到最后一页
    if (page.value > totalPages.value) {
      page.value = totalPages.value;
      await load();
    }
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

function switchType(t: string) {
  activeType.value = t;
  page.value = 1;
  load();
}

function onKeywordInput() {
  if (keywordTimer) clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => {
    keyword.value = keywordInput.value.trim();
    page.value = 1;
    load();
  }, 300);
}

/** 自定义上传：multipart POST，成功后刷新列表 */
async function doUpload(options: UploadRequestOptions) {
  uploading.value = true;
  try {
    const form = new FormData();
    form.append('file', options.file);
    const r = await api<{ document_id: string; chunk_count: number; embedding: string; merged?: boolean; version_no?: number }>(
      'POST', `/api/projects/${projectId}/documents`, form,
    );
    if (r.merged) {
      ElMessage.success(`标题与已有文档相同，已合并为新版本 v${r.version_no}；共 ${r.chunk_count} 块；${r.embedding}`);
    } else {
      ElMessage.success(`已入库 ${r.chunk_count} 块；${r.embedding}`);
    }
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    uploading.value = false;
  }
}

async function removeDoc(row: DocumentSummary) {
  try {
    await ElMessageBox.confirm(`软删除文档「${row.title}」？（版本历史保留）`, '删除文档', { type: 'warning' });
  } catch { return; }
  try {
    await api('DELETE', `/api/documents/${row.id}`);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

/** 手动修改文档分类 */
async function changeDocType(row: DocumentSummary, docType: string) {
  if (docType === row.doc_type) return;
  try {
    await api('PATCH', `/api/documents/${row.id}/doc-type`, { doc_type: docType });
    ElMessage.success('分类已更新');
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

const docTypeLabel = (t: string) => DOC_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t;
const docTypeTag = (t: string): 'primary' | 'success' | 'info' | 'warning' | 'danger' =>
  ({ requirement: 'primary', contract: 'warning', adjustment: 'danger', tech: 'success', test: 'info', other: 'info' } as const)[t as never] ?? 'info';

const sourceTag = (t: string) => ({
  web: '后台上传', mcp: 'MCP', index: '自动索引', generated: '自动生成',
  communication: '沟通记录', file: '文件', email: '邮件', chat: '聊天', meeting: '会议',
}[t] ?? t);

const countOf = (t: string) => (t === 'all' ? total.value : counts.value[t] ?? 0);

onMounted(load);
</script>

<template>
  <div style="padding: 20px">
    <PageHeader :title="project?.name ?? '…'">
      <el-tooltip content="关联拓扑图" placement="top">
        <el-button :icon="Share" @click="router.push(`/project/${projectId}/graph`)" />
      </el-tooltip>
      <el-tooltip content="上传文档（md / txt / docx / pdf），同名文档自动合并为新版本" placement="top">
        <el-upload
          ref="uploadRef"
          :show-file-list="false"
          :http-request="doUpload"
          accept=".md,.txt,.docx,.pdf"
          :disabled="uploading"
        >
          <el-button type="primary" :icon="Upload" :loading="uploading" />
        </el-upload>
      </el-tooltip>
    </PageHeader>
    <p class="page-body" style="margin-bottom: 16px; color: var(--el-text-color-secondary)">{{ project?.description }}</p>

    <!-- 分类 Tab + 搜索 -->
    <div style="margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap">
      <el-radio-group :model-value="activeType" @update:model-value="switchType">
        <el-radio-button value="all">全部（{{ countOf('all') }}）</el-radio-button>
        <el-radio-button v-for="o in DOC_TYPE_OPTIONS" :key="o.value" :value="o.value">
          {{ o.label }}（{{ countOf(o.value) }}）
        </el-radio-button>
      </el-radio-group>
      <el-input
        v-model="keywordInput"
        placeholder="按标题搜索"
        clearable
        style="width: 220px"
        :prefix-icon="Search"
        @input="onKeywordInput"
        @clear="keyword = ''; page = 1; load()"
      />
    </div>

    <el-table :data="docs" v-loading="loading" stripe>
      <el-table-column prop="title" label="标题" min-width="220">
        <template #default="{ row }">
          <el-button link type="primary" @click="router.push(`/doc/${row.id}`)">{{ row.title }}</el-button>
        </template>
      </el-table-column>
      <el-table-column prop="doc_type" label="分类" width="140">
        <template #default="{ row }">
          <el-dropdown trigger="click" @command="(v: string) => changeDocType(row, v)">
            <el-tag size="small" :type="docTypeTag(row.doc_type)" style="cursor: pointer">
              {{ docTypeLabel(row.doc_type) }}
            </el-tag>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="o in DOC_TYPE_OPTIONS"
                  :key="o.value"
                  :command="o.value"
                  :disabled="o.value === row.doc_type"
                >{{ o.label }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
      <el-table-column prop="source_type" label="来源" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.source_type === 'web' ? 'success' : 'info'">{{ sourceTag(row.source_type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="version_no" label="版本" width="80">
        <template #default="{ row }">v{{ row.version_no }}</template>
      </el-table-column>
      <el-table-column prop="updated_at" label="更新时间" width="180">
        <template #default="{ row }">{{ new Date(row.updated_at).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column label="操作" width="140">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="router.push(`/doc/${row.id}`)">查看</el-button>
          <el-button size="small" link type="danger" @click="removeDoc(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div style="margin-top: 16px; display: flex; justify-content: flex-end">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, prev, pager, next, sizes"
        @current-change="load"
        @size-change="page = 1; load()"
      />
    </div>
  </div>
</template>
