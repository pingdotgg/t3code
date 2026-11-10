// Mirrors `@cloudflare/vite-plugin`'s `playground/worker-♫` (in a directory
// whose path contains a non-ASCII character).
import { a } from "./a";

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const access = (
      ctx as unknown as {
        access?: { aud: string; getIdentity(): Promise<unknown> };
      }
    ).access;
    if (url.pathname === "/access") {
      return Response.json({
        aud: access?.aud,
        identity: await access?.getIdentity(),
      });
    }

    if (
      url.pathname ===
      // doing base path normalization, in real world you would built in framework features from libs like Hono
      `${(import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL}/x-forwarded-host`.replace(
        /\/+/g,
        "/",
      )
    ) {
      return new Response(request.headers.get("X-Forwarded-Host"));
    }

    if (url.pathname.endsWith("/host-header")) {
      return new Response(request.headers.get("Host"));
    }

    if (url.pathname.endsWith("/request-url")) {
      return new Response(request.url);
    }

    // return the pathname if the path parameter is present to test the base path
    if (url.searchParams.has("path")) {
      return new Response(url.pathname);
    }

    console.log(a);
    const { fn } = await import("./b");
    fn();

    console.debug("__console debug__");
    console.log("__console log__");
    console.warn("__console warn__");
    console.error("__console error__");

    return new Response("Hello World!");
  },
};

addEventListener("unhandledrejection", () => {
  console.error("__unhandled rejection__");
});
