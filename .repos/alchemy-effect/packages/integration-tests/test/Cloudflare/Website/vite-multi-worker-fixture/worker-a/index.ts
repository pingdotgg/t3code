// Mirrors `@cloudflare/vite-plugin`'s `playground/multi-worker` (worker A,
// the Vite Worker, calls worker B over service bindings).
import type WorkerB from "../worker-b/index.ts";
import type { NamedEntrypoint } from "../worker-b/index.ts";

interface Env {
  WORKER_B: Fetcher<WorkerB>;
  NAMED_ENTRYPOINT: Fetcher<NamedEntrypoint>;
  CONFIGURED_VAR?: string;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/fetch": {
        const response = await env.WORKER_B.fetch(request);
        const result = await response.json();
        return Response.json({
          result,
        });
      }
      case "/rpc-method": {
        const result = await env.WORKER_B.add(4, 5);
        return Response.json({
          result,
        });
      }
      case "/rpc-method/promise-pipelining": {
        const foo = env.WORKER_B.foo("🎉");
        const result = await foo.bar.baz();
        return Response.json({
          result,
        });
      }
      case "/rpc-getter": {
        const result = await env.WORKER_B.name;
        return Response.json({ result });
      }
      case "/rpc-named-entrypoint": {
        const result = await env.NAMED_ENTRYPOINT.multiply(4, 5);
        return Response.json({ result });
      }
      case "/rpc-named-entrypoint/promise-pipelining": {
        const baz = env.NAMED_ENTRYPOINT.baz("🚀");
        const result = await baz.bar.foo();
        return Response.json({
          result,
        });
      }
      case "/config-test": {
        return Response.json({
          configuredVar: env.CONFIGURED_VAR,
        });
      }
      case "/config-test/auxiliary": {
        const response = await env.WORKER_B.fetch(new Request("http://localhost/config-test"));
        return response;
      }
    }

    return Response.json({ name: "Worker A" });
  },
} satisfies ExportedHandler<Env>;
