import type { APIContext } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

/**
 * Reads a `public/` file through the Worker's `ASSETS` binding, as a server
 * route that serves or post-processes its own static files does.
 */
interface AssetsBinding {
  fetch(input: URL): Promise<Response>;
}

export async function GET({ url }: APIContext) {
  const assets = (env as { ASSETS?: AssetsBinding }).ASSETS;
  if (assets === undefined) {
    return new Response("no ASSETS binding", { status: 500 });
  }
  // A copy: the middleware sets headers, and a fetched response's are immutable.
  const response = await assets.fetch(new URL("/static.txt", url));
  return new Response(response.body, response);
}
