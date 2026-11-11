// Reads a `static/` file through the Worker's `ASSETS` binding, as a route
// that serves or post-processes its own static files does.

// Local Platform shape — see +page.server.ts.
interface Platform {
  env?: { ASSETS?: { fetch(input: URL): Promise<Response> } };
}

export const GET = async ({ platform, url }: { platform?: Platform; url: URL }) => {
  const assets = platform?.env?.ASSETS;
  if (assets === undefined) {
    return new Response("no ASSETS binding", { status: 500 });
  }
  const response = await assets.fetch(new URL("/robots.txt", url));
  return new Response(await response.text(), { status: response.status });
};
