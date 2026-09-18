<script>
  import { enhance } from "$app/forms";

  let { form } = $props();
  let hydrated = $state(false);
  $effect(() => {
    hydrated = true;
  });
</script>

<h1>Form actions</h1>
<form method="POST" action="?/greet" use:enhance>
  <input id="name" name="name" />
  <button id="submit" data-hydrated={hydrated} type="submit">greet</button>
</form>
<p id="form-result">result:{form?.greeting ?? form?.error ?? "none"}</p>
<p id="form-secret">secret:{form?.secret ?? "none"}</p>
