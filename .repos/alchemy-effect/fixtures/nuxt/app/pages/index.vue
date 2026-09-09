<script setup lang="ts">
// SSR reads the worker environment through nitro's cloudflare_module runtime
// contract: `event.context.cloudflare.env`. `useState` serializes the
// server-read value into the payload so the client render matches.
const config = useRuntimeConfig();
const secret = useState("fixture-secret", () => {
  if (import.meta.server) {
    const event = useRequestEvent();
    const env = event?.context.cloudflare?.env as Record<string, unknown> | undefined;
    return typeof env?.FIXTURE_SECRET === "string" ? env.FIXTURE_SECRET : "missing";
  }
  return "missing";
});
</script>

<template>
  <main>
    <h1 data-testid="page-marker">NUXT_FIXTURE</h1>
    <p data-testid="config-marker">{{ config.public.fixtureMarker }}</p>
    <p data-testid="env-secret">secret:{{ secret }}</p>
  </main>
</template>
