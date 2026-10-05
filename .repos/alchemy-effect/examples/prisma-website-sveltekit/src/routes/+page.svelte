<script lang="ts">
  import Card from "$lib/Card.svelte";

  let { data } = $props();
  let count = $state(0);
  let greeting = $state("");

  async function loadGreeting() {
    try {
      const response = await fetch("/api/hello?name=browser");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { greeting: string };
      greeting = body.greeting;
    } catch {
      greeting = "Could not load the greeting. Try again.";
    }
  }
</script>

<svelte:head>
  <title>SvelteKit on Prisma</title>
</svelte:head>

<main>
  <h1 class="text-3xl font-bold">{data.greeting}</h1>
  <Card
    title="Styled with Tailwind CSS"
    body="This card is a Svelte component styled with Tailwind utilities."
  />
  <button type="button" onclick={() => count++}>count: {count}</button>
  <button type="button" onclick={loadGreeting}>Load greeting</button>
  <p role="status">{greeting}</p>
  <a class="mt-4 inline-block underline" href="/about">about (prerendered)</a>
</main>
