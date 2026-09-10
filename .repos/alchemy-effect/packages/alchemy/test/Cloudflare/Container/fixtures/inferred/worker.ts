import type * as Cloudflare from "@/Cloudflare";
import { Container, getContainer } from "@cloudflare/containers";
import type { InferredClassWorker } from "./stack.ts";

/**
 * Container-backed Durable Object class hosted by a plain async Worker. The
 * class is named after the env key, so the stack omits `className` — the
 * shape the Containers guide documents and the one issue #1321 reported.
 */
export class Probe extends Container {
  defaultPort = 8080;
}

// InferEnv maps the Container binding to DurableObjectNamespace<Probe>, which
// is what `getContainer` expects — a lost binding is a type error here too.
type Env = Cloudflare.InferEnv<typeof InferredClassWorker>;

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    // What `env.Probe` actually IS at runtime: a namespace has `idFromName`;
    // a Worker that lost the binding echoes the Container declaration it
    // uploaded as json instead (`{"_id":"Effect","op":"alchemy/EffectClass"}`).
    if (url.pathname === "/binding") {
      const binding = env.Probe as unknown;
      return Response.json({
        kind:
          typeof (binding as { idFromName?: unknown } | null)?.idFromName ===
          "function"
            ? "durable_object_namespace"
            : JSON.stringify(binding),
      });
    }
    if (url.pathname === "/hello") {
      return getContainer(env.Probe, "default").fetch(request);
    }
    return new Response("ok");
  },
};
