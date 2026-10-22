<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { UploadRequestOptions } from 'element-plus';
import { Share, Upload } from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import { api, type DocumentSummary, type Project } from '../api';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id as string;

const project = ref<Project | null>(null);
const docs = ref<DocumentSummary[]>([]);
const loading = ref(false);
const uploadRef = ref();
const uploading = ref(false);

async function load() {
  loading.value = true;
  try {
    const [projects, list] = await Promise.all([
      api<Project[]>('GET', '/api/projects'),
      api<DocumentSummary[]>('GET', `/api/projects/${projectId}/documents`),
    ]);
    project.value = projects.find((p) => p.id === projectId) ?? null;
    docs.value = list;
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

/** 自定义上传：multipart POST，成功后刷新列表 */
async function doUpload(options: UploadRequestOptions) {
  uploading.value = true;
  try {
    const form = new FormData();
    form.append('file', options.file);
    const r = await api<{ document_id: string; chunk_count: number; embedding: string }>(
      'POST', `/api/projects/${projectId}/documents`, form,
    );
    ElMessage.success(`已入库 ${r.chunk_count} 块；${r.embedding}`);
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

const sourceTag = (t: string) => (t === 'web' ? '后台上传' : t === 'index' ? '自动索引' : 'MCP');

onMounted(load);
</script>

<template>
  <div style="padding: 20px">
    <PageHeader :title="project?.name ?? '…'">
      <el-tooltip content="关联拓扑图" placement="top">
        <el-button :icon="Share" @click="router.push(`/project/${projectId}/graph`)" />
      </el-tooltip>
      <el-tooltip content="上传文档（md / txt / docx / pdf）" placement="top">
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

    <el-table :data="docs" v-loading="loading" stripe>
      <el-table-column prop="title" label="标题" min-width="220">
        <template #default="{ row }">
          <el-button link type="primary" @click="router.push(`/doc/${row.id}`)">{{ row.title }}</el-button>
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
  </div>
</template>
