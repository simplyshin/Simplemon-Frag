<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import PageHeader from '../components/PageHeader.vue';
import CategoryTag from '../components/CategoryTag.vue';
import { api, type DocCategory } from '../api';

/** 预设色板（含 Element Plus 语义色对应 hex + 常用扩展色） */
const PRESET_HEX: Record<string, string> = {
  primary: '#409eff', success: '#67c23a', info: '#909399', warning: '#e6a23c', danger: '#f56c6c',
};
const PREDEFINE_COLORS = [
  '#409eff', '#67c23a', '#909399', '#e6a23c', '#f56c6c',
  '#7c3aed', '#6366f1', '#0ea5a4', '#ec4899', '#f97316',
];
/** 预设枚举 → hex（旧数据编辑时转换为具体色值，保存后统一为 hex） */
const toHex = (c: string) => PRESET_HEX[c] ?? c;

const categories = ref<DocCategory[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const r = await api<{ items: DocCategory[] }>('GET', '/api/doc-categories');
    categories.value = r.items;
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

// ---------- 新增 / 编辑（同一对话框） ----------

const dialog = ref(false);
const editing = ref<DocCategory | null>(null); // null = 新增
const form = ref({ name: '', color: 'info', sort: 100 });
const saving = ref(false);

function openAdd() {
  editing.value = null;
  form.value = { name: '', color: '#909399', sort: 100 };
  dialog.value = true;
}

function openEdit(row: DocCategory) {
  editing.value = row;
  // 旧数据存的是预设枚举名，转换为对应 hex 供选色器显示
  form.value = { name: row.name, color: toHex(row.color), sort: row.sort };
  dialog.value = true;
}

async function save() {
  if (!form.value.name.trim()) {
    ElMessage.warning('请输入分类名称');
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      await api('PATCH', `/api/doc-categories/${editing.value.id}`, { ...form.value });
      ElMessage.success('分类已更新');
    } else {
      await api('POST', '/api/doc-categories', { ...form.value });
      ElMessage.success(`分类「${form.value.name.trim()}」已创建`);
    }
    dialog.value = false;
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    saving.value = false;
  }
}

async function changeColor(row: DocCategory, color: string) {
  if (color === row.color) return;
  try {
    await api('PATCH', `/api/doc-categories/${row.id}`, { color });
    ElMessage.success('标签色已更新');
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

/** 删除自定义分类：后端自动把其下未删除文档回落到内置「其他」 */
async function removeCategory(row: DocCategory) {
  try {
    await ElMessageBox.confirm(
      `删除自定义分类「${row.name}」？该分类下 ${row.doc_count ?? 0} 篇未删除文档将自动归入内置分类「其他」。`,
      '删除分类',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch { return; }
  try {
    const r = await api<{ moved_documents: number }>('DELETE', `/api/doc-categories/${row.id}`);
    ElMessage.success(`分类已删除，${r.moved_documents} 篇文档已归入「其他」`);
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

onMounted(load);</script>

<template>
  <div style="padding: 20px">
    <PageHeader title="分类管理">
      <el-button type="primary" :icon="Plus" @click="openAdd">新增分类</el-button>
    </PageHeader>
    <p class="page-body" style="margin-bottom: 16px; color: var(--el-text-color-secondary)">
      文档分类全局共用。内置分类可改名 / 改色 / 调序，不可删除；删除自定义分类时，其下文档自动归入内置分类「其他」。
    </p>

    <el-table :data="categories" v-loading="loading" stripe>
      <el-table-column label="名称" min-width="160">
        <template #default="{ row }">
          <CategoryTag :name="row.name" :color="row.color" />
        </template>
      </el-table-column>
      <el-table-column label="标签色" width="110">
        <template #default="{ row }">
          <el-color-picker
            :model-value="toHex(row.color)"
            size="small"
            :predefine="PREDEFINE_COLORS"
            @change="(v: string | null) => v && changeColor(row, v)"
          />
        </template>
      </el-table-column>
      <el-table-column label="文档数" width="100">
        <template #default="{ row }">{{ row.doc_count ?? 0 }}</template>
      </el-table-column>
      <el-table-column prop="sort" label="排序" width="80" />
      <el-table-column label="类型" width="90">
        <template #default="{ row }">
          <el-tag v-if="row.built_in" size="small" type="warning">内置</el-tag>
          <el-tag v-else size="small" type="info">自定义</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="130">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="!row.built_in" size="small" link type="danger" @click="removeCategory(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="editing ? `编辑分类「${editing.name}」` : '新增分类'" width="440px">
      <el-form label-width="70px">
        <el-form-item label="名称">
          <el-input v-model="form.name" maxlength="30" placeholder="最多 30 字" @keyup.enter="save" />
        </el-form-item>
        <el-form-item label="标签色">
          <el-color-picker v-model="form.color" :predefine="PREDEFINE_COLORS" />
          <span style="margin-left: 10px; font-size: 12px; color: var(--el-text-color-secondary)">{{ form.color }}</span>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" :max="9999" />
          <span style="margin-left: 8px; font-size: 12px; color: var(--el-text-color-secondary)">数值越小越靠前</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
