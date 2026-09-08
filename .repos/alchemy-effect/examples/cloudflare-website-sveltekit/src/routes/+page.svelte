<script>
  import Card from "$lib/Card.svelte";

  let { data } = $props();
</script>

<svelte:head>
  <title>SvelteKit on Cloudflare</title>
</svelte:head>

<main>
  <h1 class="text-3xl font-bold">{data.greeting}</h1>
  <Card
    title="Styled with Tailwind CSS"
    body="This card is a Svelte component styled with Tailwind utilities."
  />
  <a class="mt-4 inline-block underline" href="/about">about (prerendered)</a>
</main>
