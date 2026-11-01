// Long-lived dev server for the AWS StaticSite. `alchemy dev` spawns it as
// a `Command.Dev` child inside the provider sidecar and reads the URL it
// prints. The stress suite pins PORT so the address survives every restart,
// and reads SITE_MARKER back over `/__dev-env` to prove that a change to
// `dev.env` actually RESTARTED the child rather than leaving the old one.
//
// Plain .mjs so the repo's tsc never type-checks it.
const port = Number(process.env.PORT ?? 0);
const server = Bun.serve({
  port,
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/__dev-env") {
      return Response.json({
        marker: process.env.SITE_MARKER ?? null,
        pid: process.pid,
      });
    }
    const file = Bun.file(
      `${import.meta.dirname}/site${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`,
    );
    return (await file.exists())
      ? new Response(file)
      : new Response("not found", { status: 404 });
  },
});

console.log(`AWS StaticSite dev server: http://localhost:${server.port}`);
