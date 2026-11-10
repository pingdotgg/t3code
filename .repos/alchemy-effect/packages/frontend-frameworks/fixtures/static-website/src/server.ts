// Worker-in-front-of-static-site: assets are matched first
// (`runWorkerFirst` is unset), so this worker only receives requests no
// static asset answers — the API route and everything unmatched
// (`not_found_handling: "none"` delegates 404s here).
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/hello") {
      return Response.json({ message: "Hello World", source: "worker" });
    }
    return new Response("Not Found", { status: 404 });
  },
};
