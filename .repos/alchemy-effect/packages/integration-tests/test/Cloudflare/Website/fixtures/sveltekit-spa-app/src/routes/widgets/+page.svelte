<script lang="ts">
  import type { WidgetsPayload } from "./+page.ts";

  const { data }: { data: WidgetsPayload } = $props();
</script>

<!-- None of this markup may appear in the HTTP response for /widgets:
     with `ssr = false` it renders only in the browser. -->
<h1 id="widgets-title">sveltekit-spa-widgets</h1>
<p id="widgets-server">server:{data.server ? "yes" : "no"}</p>
<p id="widgets-message">message:{data.message}</p>
<ul id="widgets-list">
  {#each data.widgets as widget (widget.id)}
    <li data-widget-id={widget.id}>{widget.name}</li>
  {/each}
</ul>
