<template>
  <!-- With `ssr: false` this markup renders ONLY in the browser: the marker
       must be absent from the raw HTML the worker/asset layer serves. -->
  <main>
    <h1>NUXT_SPA_PAGE_MARKER</h1>
    <NuxtLink to="/deep">deep</NuxtLink>
  </main>
</template>
