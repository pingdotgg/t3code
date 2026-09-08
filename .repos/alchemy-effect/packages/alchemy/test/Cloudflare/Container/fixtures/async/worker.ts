import type * as Cloudflare from "@/Cloudflare";
import { Container, getContainer } from "@cloudflare/containers";
import type { AsyncContainerWorker } from "./stack.ts";

/**
 * Container-backed Durable Object class hosted by a plain async Worker — the
 * class implementation comes from the `@cloudflare/containers` npm package
 * (the exact shape from issue #953, where the class is `@cloudflare/sandbox`'s
 * `Sandbox`). `Container.fetch` forwards requests to the echo server listening
 * on port 8080 inside the container.
 */
export class AsyncEchoObject extends Container {
  defaultPort = 8080;
}

// InferEnv maps the Container binding to DurableObjectNamespace<AsyncEchoObject>,
// which is exactly what `getContainer` expects.
type Env = Cloudflare.InferEnv<typeof AsyncContainerWorker>;

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    // Reports what `env.ECHO` actually IS at runtime. A `durable_object_
    // namespace` binding has `idFromName`; when the Worker instead uploads the
    // Container declaration as a `json` binding, this echoes that json back
    // (`{"_id":"Effect","op":"alchemy/EffectClass"}`) and `getContainer` below
    // dies with `t.idFromName is not a function`.
    if (url.pathname === "/binding") {
      const binding = env.ECHO as unknown;
      return Response.json({
        kind:
          typeof (binding as { idFromName?: unknown } | null)?.idFromName ===
          "function"
            ? "durable_object_namespace"
            : JSON.stringify(binding),
      });
    }
    if (url.pathname === "/hello") {
      return getContainer(env.ECHO, "default").fetch(request);
    }
    return new Response("ok");
  },
};
