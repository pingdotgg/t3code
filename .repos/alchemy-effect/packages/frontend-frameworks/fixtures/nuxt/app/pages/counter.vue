<script setup lang="ts">
// Client-hydration probe: the button only works (and only flips its
// data-hydrated marker) after Vue hydrates on the client.
const count = ref(0);
const hydrated = ref(false);
onMounted(() => {
  hydrated.value = true;
});
</script>

<template>
  <main>
    <p id="count">count:{{ count }}</p>
    <button id="increment" :data-hydrated="hydrated ? 'true' : 'false'" @click="count++">+1</button>
  </main>
</template>
