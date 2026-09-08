<script setup lang="ts">
// Title lives on the page so the dev test's hot-reload marker rewrite
// targets this file.
useHead({ title: "Nuxt on AWS" });

// SSR reads the Lambda environment through the plain Node contract:
// `process.env`. `useState` serializes the server-read value into the
// payload so the client render matches.
const greeting = useState("greeting", () => {
  if (import.meta.server) {
    return typeof process.env.GREETING === "string"
      ? process.env.GREETING
      : "Hello!";
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
