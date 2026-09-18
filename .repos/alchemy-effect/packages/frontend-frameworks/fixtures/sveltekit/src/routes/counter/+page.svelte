<script>
  let count = $state(0);
  let hydrated = $state(false);
  $effect(() => {
    hydrated = true;
  });
</script>

<h1>Counter</h1>
<button id="increment" data-hydrated={hydrated} onclick={() => count++}>increment</button>
<p id="count">count:{count}</p>
<a href="/">home</a>
