import type { AsyncWorkerEnv } from "./stack.ts";

/**
 * Async (non-Effect) Worker fixture for the Artifacts namespace binding
 * declared via `env: { REPOS: Cloudflare.Artifacts.Namespace(...) }`. `InferEnv` maps the
 * marker to the native `cf.Artifacts` binding, so the handler calls
 * `env.REPOS.create/list/get/delete(...)` directly. Mirrors the exact same
 * routes the Effect-native worker drives (see `routes.ts`).
 */
export default {
  async fetch(request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "";
    const repos = env.REPOS;

    if (url.pathname === "/create") {
      const repo = await repos.create(name, { setDefaultBranch: "main" });
      return Response.json({
        name: repo.name,
        remote: repo.remote,
        defaultBranch: repo.defaultBranch,
        hasToken: typeof repo.token === "string" && repo.token.length > 0,
      });
    }

    if (url.pathname === "/list") {
      const result = await repos.list();
      return Response.json({
        names: result.repos.map((r) => r.name),
        total: result.total,
      });
    }

    if (url.pathname === "/get") {
      try {
        await repos.get(name);
        return Response.json({ found: true });
      } catch {
        return Response.json({ found: false });
      }
    }

    if (url.pathname === "/delete") {
      const deleted = await repos.delete(name);
      return Response.json({ deleted });
    }

    return new Response("Not Found", { status: 404 });
  },
};
