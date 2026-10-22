<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import PageHeader from '../components/PageHeader.vue';
import { api, type Project, type SearchResult } from '../api';

const router = useRouter();
const projects = ref<Project[]>([]);
const projectId = ref('');
const query = ref('');
const loading = ref(false);
const result = ref<SearchResult | null>(null);
const searched = ref('');

async function loadProjects() {
  projects.value = await api<Project[]>('GET', '/api/projects');
  if (projects.value.length && !projectId.value) projectId.value = projects.value[0].id;
}

async function search() {
  if (!query.value.trim()) return ElMessage.warning('请输入查询词');
  loading.value = true;
  try {
    result.value = await api<SearchResult>('POST', '/api/search', {
      projectId: projectId.value, query: query.value,
    });
    searched.value = query.value;
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

const sourceTag = (s: string) => (s === 'vector' ? '语义' : s === 'fts' ? '关键词' : '兜底');
const sourceType = (s: string) => (s === 'vector' ? 'success' : s === 'fts' ? 'primary' : 'info');

onMounted(loadProjects);
</script>

<template>
  <div style="padding: 20px">
    <PageHeader title="文档检索" />
    <div class="page-body" style="display: flex; gap: 12px; margin-bottom: 16px">
      <el-select v-model="projectId" style="width: 220px">
        <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-input
        v-model="query" placeholder="支持口语化语义查询，如「钱怎么退回来」"
        @keyup.enter="search" clearable
      />
      <el-button type="primary" :loading="loading" @click="search">检索</el-button>
    </div>

    <template v-if="result">
      <p style="color: var(--el-text-color-secondary)">
        「{{ searched }}」命中 {{ result.total }} 条
        <el-tag size="small" :type="result.meta.vector ? 'success' : 'info'" style="margin-left: 6px">
          {{ result.meta.vector ? '向量路可用' : '向量路未就绪（仅关键词）' }}
        </el-tag>
      </p>
      <el-empty v-if="!result.total" description="没有命中结果" />
      <el-card v-for="(h, i) in result.hits" :key="i" shadow="hover" style="margin-bottom: 10px">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px">
          <div>
            <el-button link type="primary" @click="router.push(`/doc/${h.document_id}`)">
              {{ h.document_title }}
            </el-button>
            <span style="color: var(--el-text-color-secondary); font-size: 13px; margin-left: 8px">
              {{ h.heading_path }} · v{{ h.version_no }}
            </span>
          </div>
          <div>
            <el-tag size="small" :type="sourceType(h.source)">{{ sourceTag(h.source) }}</el-tag>
            <span style="color: var(--el-text-color-secondary); font-size: 12px; margin-left: 6px">
              score {{ h.score }}
            </span>
          </div>
        </div>
        <div style="white-space: pre-wrap; font-size: 14px; line-height: 1.6">{{ h.content }}</div>
      </el-card>
    </template>
  </div>
</template>
