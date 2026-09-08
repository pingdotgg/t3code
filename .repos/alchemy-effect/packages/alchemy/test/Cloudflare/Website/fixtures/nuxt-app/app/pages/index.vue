<script setup lang="ts">
// SSR reads the worker environment through nitro's cloudflare_module
// runtime contract: `event.context.cloudflare.env`. `useState` serializes
// the server-read value into the payload so the client render matches.
const config = useRuntimeConfig();
const binding = useState("test-binding", () => {
  if (import.meta.server) {
    const event = useRequestEvent();
    const env = event?.context.cloudflare?.env as
      | Record<string, unknown>
      | undefined;
    return typeof env?.TEST_BINDING === "string" ? env.TEST_BINDING : "missing";
  }
  return "missing";
});
</script>

<template>
  <main>
    <h1>NUXT_PAGE_MARKER</h1>
    <p>config:{{ config.public.fixtureMarker }}</p>
    <p>binding:{{ binding }}</p>
  </main>
</template>
