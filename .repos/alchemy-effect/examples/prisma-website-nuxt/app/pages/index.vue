<script setup lang="ts">
useHead({ title: "Nuxt on Prisma" });

const greeting = useState("greeting", () =>
  import.meta.server ? (process.env.GREETING ?? "Hello!") : "Hello!",
);
const count = ref(0);
const responseGreeting = ref("");

async function loadGreeting() {
  try {
    const result = await $fetch<{ greeting: string }>(
      "/api/hello?name=browser",
    );
    responseGreeting.value = result.greeting;
  } catch {
    responseGreeting.value = "Could not load the greeting. Try again.";
  }
}
</script>

<template>
  <main>
    <h1 class="text-3xl font-bold">{{ greeting }}</h1>
    <Card
      title="Styled with Tailwind CSS"
      body="This card is a Vue component styled with Tailwind utilities."
    />
    <button type="button" @click="count++">count: {{ count }}</button>
    <button type="button" @click="loadGreeting">Load greeting</button>
    <p role="status">{{ responseGreeting }}</p>
    <NuxtLink class="mt-4 inline-block underline" to="/about"
      >about (prerendered)</NuxtLink
    >
  </main>
</template>
