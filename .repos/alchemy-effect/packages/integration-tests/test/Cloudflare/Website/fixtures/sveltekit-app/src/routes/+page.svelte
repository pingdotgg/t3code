<script>
  let { data } = $props();
</script>

<h1>SvelteKit SSR home</h1>
<p id="binding">binding:{data.binding}</p>
<p id="ctx">ctx:{data.hasCtx ? "yes" : "no"}</p>
<a href="/prerendered">prerendered</a>
