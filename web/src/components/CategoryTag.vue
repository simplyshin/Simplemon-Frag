<script setup lang="ts">
import { computed } from 'vue';

/**
 * 分类标签统一渲染：
 * - color 为预设枚举（primary/success/info/warning/danger）→ el-tag type 语义色
 * - color 为 hex（#rgb / #rrggbb）→ 自定义背景色，文字按亮度自动取黑/白
 */
const props = withDefaults(
  defineProps<{
    name: string;
    color?: string;
    size?: 'small' | 'default' | 'large';
  }>(),
  { color: 'info', size: 'small' },
);

const PRESET_TYPES = ['primary', 'success', 'info', 'warning', 'danger'] as const;
type PresetType = (typeof PRESET_TYPES)[number];

const isPreset = computed(() => (PRESET_TYPES as readonly string[]).includes(props.color));
const presetType = computed(() => (props.color as PresetType) ?? 'info');

/** hex 背景 → 黑/白文字（亮度阈值法），保证任意自定义色可读 */
const contrastText = computed(() => {
  let hex = props.color.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#1f2d3d' : '#ffffff';
});
</script>

<template>
  <el-tag v-if="isPreset" :type="presetType" :size="size">{{ name }}</el-tag>
  <el-tag
    v-else
    :size="size"
    :color="color"
    :style="{ color: contrastText, borderColor: color }"
  >{{ name }}</el-tag>
</template>
