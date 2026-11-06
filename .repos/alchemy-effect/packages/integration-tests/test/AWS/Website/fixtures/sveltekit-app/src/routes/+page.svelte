<script>
  let { data } = $props();
</script>

<h1>SvelteKit AWS SSR home</h1>
<p id="marker">{data.marker}</p>
<a href="/prerendered">prerendered</a>
