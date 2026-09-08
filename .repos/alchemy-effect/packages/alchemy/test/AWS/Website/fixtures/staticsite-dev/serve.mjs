// Minimal long-lived dev server for the AWS StaticSite fixture: serves
// ./site over HTTP on an ephemeral port and prints its own localhost URL,
// which `Command.Dev` extracts from stdout and surfaces as the site's dev
// `url`.
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
    // Echoes exactly what the origin received, so a test can compare the
    // request an emulated CloudFront edge forwarded against the request the
    // TestFunction API says the same function produced.
    if (pathname.endsWith("/__echo")) {
      return Response.json({
        marker: process.env.DEV_MARKER ?? null,
        path: pathname,
        headers: Object.fromEntries(request.headers),
      });
    }
    // Directory-style paths resolve to their index page, so a site mounted
    // under a Router path prefix (`/docs/`) serves like a real static host.
    const file = Bun.file(
      `${process.cwd()}/site${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`,
    );
    return (await file.exists())
      ? new Response(file)
      : new Response("not found", { status: 404 });
  },
});

console.log(`StaticSite fixture dev server: http://localhost:${server.port}`);
