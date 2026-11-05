import { env } from "cloudflare:workers";

// Reads a `public/` file through the Worker's `ASSETS` binding, as a route
// that serves or post-processes its own static files does.

interface AssetsBinding {
  fetch(input: URL): Promise<Response>;
}

export const GET = async (request: Request): Promise<Response> => {
  const assets = (env as { ASSETS?: AssetsBinding }).ASSETS;
  if (assets === undefined) {
    return new Response("no ASSETS binding", { status: 500 });
  }
  const response = await assets.fetch(new URL("/robots.txt", request.url));
  return new Response(await response.text(), { status: response.status });
};
