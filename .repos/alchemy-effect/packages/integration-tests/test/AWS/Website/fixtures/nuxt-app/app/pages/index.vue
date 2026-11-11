<script setup lang="ts">
const config = useRuntimeConfig();
</script>

<template>
  <main>
    <h1>NUXT_AWS_PAGE_MARKER</h1>
    <p>config:{{ config.public.fixtureMarker }}</p>
    <p>env:{{ config.public.envMarker }}</p>
  </main>
</template>
