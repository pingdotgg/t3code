// Reads a `public/` file through the Worker's `ASSETS` binding, as a route
// that serves or post-processes its own static files does.
export default defineEventHandler(async (event) => {
  const assets = (
    event.context.cloudflare as
      | { env?: { ASSETS?: { fetch(input: URL): Promise<Response> } } }
      | undefined
  )?.env?.ASSETS;
  if (assets === undefined) {
    return new Response("no ASSETS binding", { status: 500 });
  }
  const response = await assets.fetch(new URL("/robots.txt", getRequestURL(event)));
  return new Response(await response.text(), { status: response.status });
});
