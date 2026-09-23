<script>
  let { form } = $props();
</script>

<h1>Form actions</h1>
<form method="POST" action="?/greet">
  <input id="name" name="name" />
  <button id="submit" type="submit">greet</button>
</form>
<p id="form-result">result:{form?.greeting ?? form?.error ?? "none"}</p>
<p id="form-binding">form-binding:{form?.binding ?? "none"}</p>
