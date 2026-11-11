// Async (non-Effect) Worker that exercises `vpc_service` Fetcher bindings.
// The binding under test is selected with `?binding=NAME` (default `VPC`) so
// one worker can exercise several services — e.g. the managed resource and a
// `lookup` data source side by side.
interface FetcherLike {
  fetch(input: string, init?: { signal?: AbortSignal }): Promise<Response>;
}

type Env = Record<string, FetcherLike | undefined>;

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const binding = env[url.searchParams.get("binding") ?? "VPC"];
    if (url.pathname === "/type") {
      return Response.json({ type: typeof binding?.fetch });
    }
    if (url.pathname === "/proxy") {
      const target = url.searchParams.get("url") ?? "http://vpc/";
      try {
        const res = await binding!.fetch(target, {
          signal: AbortSignal.timeout(10_000),
        });
        return Response.json({ status: res.status, body: await res.text() });
      } catch (e) {
        return Response.json({ error: String(e) });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
