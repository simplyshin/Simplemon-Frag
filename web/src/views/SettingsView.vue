<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import PageHeader from '../components/PageHeader.vue';
import { api, type Settings } from '../api';

const loading = ref(false);
const saving = ref(false);
const s = ref<Settings | null>(null);

const LLM_PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'zhipu', label: '智谱' },
];

async function load() {
  loading.value = true;
  try {
    s.value = await api<Settings>('GET', '/api/settings');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!s.value) return;
  saving.value = true;
  try {
    await api('PUT', '/api/settings', {
      llm: { provider: s.value.llm.provider },
      embedding: {
        provider: s.value.embedding.provider,
        baseUrl: s.value.embedding.baseUrl,
        model: s.value.embedding.model,
        apiKeyEnv: s.value.embedding.apiKeyEnv,
      },
      chunking: s.value.chunking,
    });
    ElMessage.success('已保存并热切换 Provider（embedding 模型变化将自动重建向量表）');
    load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div style="padding: 20px" v-loading="loading">
    <PageHeader title="Provider 设置" />
    <el-alert
      class="page-body"
      type="info" :closable="false" style="margin-bottom: 16px"
      title="API key 不在本页保存：请在项目根目录 .env 中配置对应环境变量（如 ZHIPU_API_KEY）。本页只切换 provider 与引用的环境变量名。"
    />

    <template v-if="s">
      <el-card shadow="never" style="margin-bottom: 16px">
        <template #header><b>LLM Provider</b>（P4 文档生成 / 摘要用）</template>
        <el-form label-width="130">
          <el-form-item label="当前 provider">
            <el-select v-model="s.llm.provider" style="width: 240px">
              <el-option v-for="p in LLM_PROVIDERS" :key="p.value" :label="p.label" :value="p.value" />
            </el-select>
          </el-form-item>
          <el-form-item v-for="(cfg, name) in s.llm.providers" :key="name" :label="String(name)">
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
              <el-tag size="small" :type="cfg.hasKey ? 'success' : 'danger'">
                {{ cfg.hasKey ? `已配置 ${cfg.keyHint}` : '未配置 key' }}
              </el-tag>
              <span style="color: var(--el-text-color-secondary); font-size: 13px">
                env: {{ cfg.apiKeyEnv }} · {{ cfg.model || '(默认模型)' }}
              </span>
            </div>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" style="margin-bottom: 16px">
        <template #header><b>Embedding Provider</b>（语义检索）</template>
        <el-form label-width="130">
          <el-form-item label="provider">
            <el-radio-group v-model="s.embedding.provider">
              <el-radio-button value="local">local（默认，零 key）</el-radio-button>
              <el-radio-button value="openai-compatible">openai-compatible</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="local 模型">
            <el-input v-model="s.embedding.local.model" style="width: 320px" disabled />
          </el-form-item>
          <template v-if="s.embedding.provider === 'openai-compatible'">
            <el-form-item label="baseUrl">
              <el-input v-model="s.embedding.baseUrl" style="width: 400px" />
            </el-form-item>
            <el-form-item label="model">
              <el-input v-model="s.embedding.model" style="width: 320px" />
            </el-form-item>
          </template>
          <el-form-item label="key 环境变量名">
            <el-input v-model="s.embedding.apiKeyEnv" style="width: 240px" />
            <el-tag size="small" :type="s.embedding.hasKey ? 'success' : 'danger'" style="margin-left: 8px">
              {{ s.embedding.hasKey ? `已配置 ${s.embedding.keyHint}` : '未配置' }}
            </el-tag>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" style="margin-bottom: 16px">
        <template #header><b>分块配置</b></template>
        <el-form label-width="130" inline>
          <el-form-item label="maxTokens">
            <el-input-number v-model="s.chunking.maxTokens" :min="200" :max="4000" />
          </el-form-item>
          <el-form-item label="overlap">
            <el-input-number v-model="s.chunking.overlap" :min="0" :max="500" />
          </el-form-item>
        </el-form>
      </el-card>

      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </div>
</template>
