// The playground's prerender Worker and entry Worker in one: alchemy has no
// separate prerender Worker, so the build's preview server renders
// `/prerendered` from the entry Worker itself.
interface Env {
  AUXILIARY_WORKER: Fetcher;
}

export default {
  async fetch(request, env) {
    // The build must ship this declaration as written
    using _scope = { [Symbol.dispose]() {} };
    const url = new URL(request.url);

    if (url.pathname === "/prerendered") {
      const auxiliaryResponse = await env.AUXILIARY_WORKER.fetch(request);
      const auxiliaryText = await auxiliaryResponse.text();
      return new Response(
        `\
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Pre-rendering</title>
</head>
<body>
	<h1>Pre-rendered HTML ${auxiliaryText}</h1>
</body>
</html>`,
        {
          headers: { "Content-Type": "text/html" },
        },
      );
    }

    if (url.pathname === "/hello") {
      return new Response("Hello world");
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
