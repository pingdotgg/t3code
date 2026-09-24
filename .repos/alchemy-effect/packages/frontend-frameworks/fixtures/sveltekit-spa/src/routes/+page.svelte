<script lang="ts">
  // Flips after hydration — in SPA mode nothing renders without it.
  let hydrated = $state(false);
  $effect(() => {
    hydrated = true;
  });
</script>

<h1 id="home-title">sveltekit-spa-home</h1>
<p id="hydrated">hydrated:{hydrated ? "yes" : "no"}</p>
<!-- Rewritten by the preprocessor registered in the user's svelte.config.js -->
<p id="svelte-config">marker:__SVELTE_CONFIG_MARKER__</p>
