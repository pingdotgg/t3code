<script>
  // A Svelte component styled with Tailwind utility classes.
  let { title, body } = $props();
</script>

<div
  class="mt-6 max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
>
  <h2 class="text-lg font-semibold">{title}</h2>
  <p class="mt-2 text-slate-600">{body}</p>
</div>
