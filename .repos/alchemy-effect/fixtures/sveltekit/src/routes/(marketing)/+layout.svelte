<script>
  let { data, children } = $props();
</script>

<p id="layout-section">section:{data.section}</p>
<p id="layout-secret">layout-secret:{data.layoutSecret}</p>
{@render children()}
