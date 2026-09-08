// Minimal long-lived dev server for the StaticSite fixture: serves ./src
// over HTTP on an ephemeral port and prints its own localhost URL, which
// `Command.Dev` extracts from stdout and surfaces as the site's dev `url`.
//
// `/__dev-env` echoes the DEV_MARKER environment variable so tests can
// prove that `dev.env` reached the spawned child process.
//
// Plain .mjs (not .ts) so the test project's tsc never type-checks it —
// it only ever runs under bun as a fixture child process.
const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/__dev-env") {
      return Response.json({ marker: process.env.DEV_MARKER ?? null });
    }
    const file = Bun.file(
      `${process.cwd()}/src${pathname === "/" ? "/index.html" : pathname}`,
    );
    return (await file.exists())
      ? new Response(file)
      : new Response("not found", { status: 404 });
  },
});

console.log(`StaticSite fixture dev server: http://localhost:${server.port}`);
