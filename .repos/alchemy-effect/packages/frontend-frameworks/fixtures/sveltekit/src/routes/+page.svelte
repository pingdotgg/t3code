<script>
  let { data } = $props();
</script>

<h1>SSR home</h1>
<p id="secret">secret:{data.secret}</p>
<p id="ctx">ctx:{data.hasCtx ? "yes" : "no"}</p>
<p id="devalued">devalued:{data.devalued}</p>
<a href="/counter">counter</a>
<a href="/prerendered">prerendered</a>
