<script setup lang="ts">
// A Vue component styled with Tailwind utility classes.
defineProps<{ title: string; body: string }>();
</script>

<template>
  <div
    class="mt-6 max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
  >
    <h2 class="text-lg font-semibold">{{ title }}</h2>
    <p class="mt-2 text-slate-600">{{ body }}</p>
  </div>
</template>
