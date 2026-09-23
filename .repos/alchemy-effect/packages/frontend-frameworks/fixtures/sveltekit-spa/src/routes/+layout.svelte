<script lang="ts">
  const { children } = $props();
</script>

<nav>
  <a id="nav-home" href="/">home</a>
  <a id="nav-widgets" href="/widgets">widgets</a>
  <a id="nav-about" href="/about">about</a>
</nav>

<main>
  {@render children()}
</main>
