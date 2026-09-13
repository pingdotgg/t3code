<script setup lang="ts">
useHead({ title: "Nuxt on Cloudflare" });

// SSR reads the Worker environment through nitro's cloudflare_module
// runtime contract: `event.context.cloudflare.env`. `useState` serializes
// the server-read value into the payload so the client render matches.
const greeting = useState("greeting", () => {
  if (import.meta.server) {
    const event = useRequestEvent();
    const env = event?.context.cloudflare?.env as
      | Record<string, unknown>
      | undefined;
    return typeof env?.GREETING === "string" ? env.GREETING : "Hello!";
  }
  return "Hello!";
});
</script>

<template>
  <main>
    <h1 class="text-3xl font-bold">{{ greeting }}</h1>
    <Card
      title="Styled with Tailwind CSS"
      body="This card is a Vue component styled with Tailwind utilities."
    />
    <NuxtLink class="mt-4 inline-block underline" to="/about"
      >about (prerendered)</NuxtLink
    >
  </main>
</template>
