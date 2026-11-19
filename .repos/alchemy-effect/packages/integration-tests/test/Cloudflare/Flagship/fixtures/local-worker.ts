// Async (non-Effect) Worker that exercises the native `flagship` binding:
// `/details?flag=<key>&country=<c>` evaluates `env.FLAGS.getBooleanDetails`
// with the query's context. Used by the local (dev) test against both the
// local simulator and, via `Alchemy.remote()`, the remote-proxied live app.
interface Env {
  FLAGS: {
    getBooleanDetails(
      flagKey: string,
      defaultValue: boolean,
      context?: Record<string, unknown>,
    ): Promise<{ value: boolean; variant?: string; reason?: string; errorCode?: string }>;
  };
}

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/details") {
      const flag = url.searchParams.get("flag") ?? "";
      const context: Record<string, unknown> = { targetingKey: "user-42" };
      const country = url.searchParams.get("country");
      if (country !== null) context.country = country;
      return Response.json(await env.FLAGS.getBooleanDetails(flag, false, context));
    }
    return new Response("Not Found", { status: 404 });
  },
};
