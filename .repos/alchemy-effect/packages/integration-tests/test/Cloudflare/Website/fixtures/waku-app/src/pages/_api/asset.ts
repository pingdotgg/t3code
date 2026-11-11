import { readEnv } from "../../env.ts";

// Reads a `public/` file through the Worker's `ASSETS` binding, as a route
// that serves or post-processes its own static files does. Answers `/asset`.

interface AssetsBinding {
  fetch(input: URL): Promise<Response>;
}

export const GET = async (request: Request): Promise<Response> => {
  const assets = (await readEnv()).ASSETS as AssetsBinding | undefined;
  if (assets === undefined) {
    return new Response("no ASSETS binding", { status: 500 });
  }
  const response = await assets.fetch(new URL("/hello.txt", request.url));
  return new Response(response.body, response);
};
