<script lang="ts">
  import type { WidgetsPayload } from "./+page.ts";

  const { data }: { data: WidgetsPayload & { description: string } } = $props();
</script>

<h1 id="widgets-title">sveltekit-spa-widgets</h1>
<!-- `server:yes` proves the +server.ts endpoint ran server-side (it sets
     `server: true` and reads a platform binding) even though this page's
     load ran in the browser. -->
<p id="widgets-server">server:{data.server ? "yes" : "no"}</p>
<p id="widgets-message">message:{data.message}</p>
<p id="widgets-description">{data.description}</p>
<ul id="widgets-list">
  {#each data.widgets as widget (widget.id)}
    <li data-widget-id={widget.id}>{widget.name}</li>
  {/each}
</ul>
