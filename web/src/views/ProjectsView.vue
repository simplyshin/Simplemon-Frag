<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import PageHeader from '../components/PageHeader.vue';
import { api, type Project } from '../api';

const router = useRouter();
const projects = ref<Project[]>([]);
const loading = ref(false);
const dialog = ref(false);
const form = ref({ name: '', description: '' });

async function load() {
  loading.value = true;
  try {
    projects.value = await api<Project[]>('GET', '/api/projects');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function create() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写项目名称');
  try {
    const p = await api<Project>('POST', '/api/projects', form.value);
    dialog.value = false;
    form.value = { name: '', description: '' };
    ElMessage.success('项目已创建');
    router.push(`/project/${p.id}`);
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function remove(p: Project) {
  try {
    await ElMessageBox.confirm(
      `将物理删除项目「${p.name}」及其全部文档、版本与向量索引，不可恢复。`,
      '删除项目',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch { return; }
  try {
    await api('DELETE', `/api/projects/${p.id}`);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

onMounted(load);
</script>

<template>
  <div style="padding: 20px">
    <PageHeader title="项目管理">
      <el-button type="primary" @click="dialog = true">新建项目</el-button>
    </PageHeader>

    <el-table :data="projects" v-loading="loading" stripe class="page-body">
      <el-table-column prop="name" label="名称" min-width="180" />
      <el-table-column prop="description" label="描述" min-width="240" show-overflow-tooltip />
      <el-table-column prop="created_at" label="创建时间" width="180">
        <template #default="{ row }">{{ new Date(row.created_at).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button size="small" type="primary" link @click="router.push(`/project/${row.id}`)">文档</el-button>
          <el-button size="small" type="danger" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" title="新建项目" width="440">
      <el-form label-width="70">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="如：XX 系统需求文档" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="create">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>
