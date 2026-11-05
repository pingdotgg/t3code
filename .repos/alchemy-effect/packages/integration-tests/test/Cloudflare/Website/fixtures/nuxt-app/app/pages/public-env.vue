<script setup lang="ts">
// Vite inlines `VITE_*` into the client bundle at build time.
const marker = import.meta.env.VITE_SITE_MARKER;
</script>

<template>
  <p>{{ marker }}</p>
</template>
