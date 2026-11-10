<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { UploadRequestOptions } from 'element-plus';
import { Search, Share, Setting, Upload } from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import { api, type DocCategory, type DocumentListResult, type DocumentSummary, type Project } from '../api';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id as string;

const project = ref<Project | null>(null);
const docs = ref<DocumentSummary[]>([]);
const loading = ref(false);
const uploadRef = ref();
const uploading = ref(false);

// 分类（动态，来自 /api/doc-categories）/ 时间筛选 / 搜索 / 分页状态
const categories = ref<DocCategory[]>([]);
const activeType = ref<string>('all');
const dateRange = ref<[string, string] | null>(null);
const keywordInput = ref('');
const keyword = ref('');
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const counts = ref<Record<string, number>>({});
let keywordTimer: ReturnType<typeof setTimeout> | null = null;

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

const TAG_COLORS = [
  { value: 'primary', label: '主色' },
  { value: 'success', label: '绿色' },
  { value: 'info', label: '灰色' },
  { value: 'warning', label: '橙色' },
  { value: 'danger', label: '红色' },
] as const;

async function loadCategories() {
  try {
    const r = await api<{ items: DocCategory[] }>('GET', '/api/doc-categories');
    categories.value = r.items;
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

const catNameMap = computed(() => Object.fromEntries(categories.value.map((c) => [c.id, c.name])));
const catColorMap = computed(() => Object.fromEntries(categories.value.map((c) => [c.id, c.color])));
const docTypeLabel = (t: string) => catNameMap.value[t] ?? t;
const docTypeTag = (t: string): 'primary' | 'success' | 'info' | 'warning' | 'danger' =>
  (catColorMap.value[t] as 'primary' | 'success' | 'info' | 'warning' | 'danger' | undefined) ?? 'info';

/** 本地时区日期 → UTC ISO 边界（updated_at 存 UTC，按本地"自然日"对齐） */
const toIso = (d: string, endOfDay = false) =>
  new Date(`${d}T${endOfDay ? '23:59:59.999' : '00:00:00'}`).toISOString();

async function load() {
  loading.value = true;
  try {
    const [projects, list] = await Promise.all([
      api<Project[]>('GET', '/api/projects'),
      api<DocumentListResult>('GET',
        `/api/projects/${projectId}/documents`
        + `?page=${page.value}&page_size=${pageSize.value}`
        + (activeType.value !== 'all' ? `&doc_type=${activeType.value}` : '')
        + (keyword.value ? `&keyword=${encodeURIComponent(keyword.value)}` : '')
        + (dateRange.value?.[0] ? `&updated_from=${encodeURIComponent(toIso(dateRange.value[0]))}` : '')
        + (dateRange.value?.[1] ? `&updated_to=${encodeURIComponent(toIso(dateRange.value[1], true))}` : '')),
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

function switchType() {
  page.value = 1;
  load();
}

function onDateRangeChange() {
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

// ---------- 分类管理 ----------

const catDialog = ref(false);
const newCatName = ref('');
const newCatColor = ref('info');
const catSaving = ref(false);

async function addCategory() {
  const name = newCatName.value.trim();
  if (!name) {
    ElMessage.warning('请输入分类名称');
    return;
  }
  catSaving.value = true;
  try {
    await api('POST', '/api/doc-categories', { name, color: newCatColor.value });
    newCatName.value = '';
    ElMessage.success(`分类「${name}」已添加`);
    await loadCategories();
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    catSaving.value = false;
  }
}

async function renameCategory(row: DocCategory) {
  let name: string;
  try {
    const r = await ElMessageBox.prompt(`修改分类「${row.name}」的名称`, '重命名分类', {
      inputValue: row.name,
      inputPattern: /\S+/,
      inputErrorMessage: '名称不能为空',
    });
    name = (r.value ?? '').trim();
  } catch { return; }
  if (!name || name === row.name) return;
  try {
    await api('PATCH', `/api/doc-categories/${row.id}`, { name });
    ElMessage.success('已重命名');
    await loadCategories();
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function changeColor(row: DocCategory, color: string) {
  if (color === row.color) return;
  try {
    await api('PATCH', `/api/doc-categories/${row.id}`, { color });
    ElMessage.success('标签色已更新');
    await loadCategories();
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function removeCategory(row: DocCategory) {
  try {
    await ElMessageBox.confirm(
      `删除自定义分类「${row.name}」？该分类下的文档将自动归入「其他」。`,
      '删除分类',
      { type: 'warning' },
    );
  } catch { return; }
  try {
    await api<{ moved_documents: number }>('DELETE', `/api/doc-categories/${row.id}`);
    ElMessage.success('分类已删除');
    if (activeType.value === row.id) activeType.value = 'all';
    await loadCategories();
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

function openCatDialog() {
  catDialog.value = true;
  loadCategories();
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

const sourceTag = (t: string) => ({
  web: '后台上传', mcp: 'MCP', index: '自动索引', generated: '自动生成',
  communication: '沟通记录', file: '文件', email: '邮件', chat: '聊天', meeting: '会议',
}[t] ?? t);

const countOf = (t: string) => (t === 'all' ? total.value : counts.value[t] ?? 0);

onMounted(() => {
  load();
  loadCategories();
});
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

    <!-- 分类下拉 + 时间筛选 + 搜索 -->
    <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
      <el-select
        v-model="activeType"
        style="width: 200px"
        placeholder="全部分类"
        @change="switchType"
      >
        <el-option value="all" :label="`全部（${countOf('all')}）`" />
        <el-option v-for="c in categories" :key="c.id" :value="c.id" :label="`${c.name}（${countOf(c.id)}）`" />
      </el-select>
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="更新起始日"
        end-placeholder="更新截止日"
        range-separator="至"
        unlink-panels
        clearable
        style="width: 260px"
        @change="onDateRangeChange"
      />
      <el-button :icon="Setting" @click="openCatDialog">管理分类</el-button>
      <el-input
        v-model="keywordInput"
        placeholder="按标题搜索"
        clearable
        style="width: 220px; margin-left: auto"
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
                  v-for="c in categories"
                  :key="c.id"
                  :command="c.id"
                  :disabled="c.id === row.doc_type"
                >{{ c.name }}</el-dropdown-item>
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

    <!-- 分类管理 -->
    <el-dialog v-model="catDialog" title="分类管理" width="600px">
      <el-table :data="categories" size="small" max-height="360">
        <el-table-column prop="name" label="名称" min-width="140">
          <template #default="{ row }">
            <el-tag size="small" :type="docTypeTag(row.id)">{{ row.name }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="标签色" width="130">
          <template #default="{ row }">
            <el-select :model-value="row.color" size="small" @change="(v: string) => changeColor(row, v)">
              <el-option v-for="c in TAG_COLORS" :key="c.value" :value="c.value" :label="c.label" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="内置" width="70">
          <template #default="{ row }">
            <el-tag v-if="row.built_in" size="small" type="warning">内置</el-tag>
            <el-tag v-else size="small" type="info">自定义</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="renameCategory(row)">重命名</el-button>
            <el-button v-if="!row.built_in" size="small" link type="danger" @click="removeCategory(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div style="margin-top: 14px; display: flex; gap: 8px; align-items: center">
        <el-input
          v-model="newCatName"
          placeholder="新分类名称（最多 30 字）"
          maxlength="30"
          style="width: 220px"
          @keyup.enter="addCategory"
        />
        <el-select v-model="newCatColor" style="width: 110px">
          <el-option v-for="c in TAG_COLORS" :key="c.value" :value="c.value" :label="c.label" />
        </el-select>
        <el-button type="primary" :loading="catSaving" @click="addCategory">添加分类</el-button>
      </div>
      <template #footer>
        <el-button @click="catDialog = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>
