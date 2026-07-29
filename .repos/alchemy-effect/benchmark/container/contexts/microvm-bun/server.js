// Dumbest possible bun HTTP server — the cold-start baseline. Mirrors the
// effectful Sandbox's two routes (`/echo` and a default text response) so the
// in-VM workload is identical; everything that differs in time-to-usable is
// the alchemy/Effect abstraction, not the work the server does.
const port = Number(process.env.PORT ?? 8080);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/echo") {
      return Response.json({ message: url.searchParams.get("message") ?? "" });
    }
    return new Response("hello from bun microvm");
  },
});

console.log(`bun microvm baseline listening on :${port}`);
