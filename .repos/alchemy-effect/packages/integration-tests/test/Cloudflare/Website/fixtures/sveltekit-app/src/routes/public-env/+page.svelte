<script>
  // Vite inlines `VITE_*` into the client bundle at build time.
  const marker = import.meta.env.VITE_SITE_MARKER;
</script>

<p id="public-env">{marker}</p>
