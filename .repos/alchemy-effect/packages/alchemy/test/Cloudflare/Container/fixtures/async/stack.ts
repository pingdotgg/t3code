import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as path from "pathe";
import type { AsyncEchoObject } from "./worker.ts";

/**
 * A Container bound directly in an async Worker's `env` (issue #953): the
 * Container IS the Durable Object binding plus its ContainerApplication.
 * The class implementation ships inside the worker script (from
 * `@cloudflare/containers`); `className` names the exported class since it
 * differs from the binding name (`ECHO`).
 *
 * The Container's logical id deliberately MATCHES the env key. The Worker's
 * `durable_object_namespace` binding and its `containers` script metadata
 * describe the same env entry and must be contributed under one `sid` —
 * binding rows are collapsed by sid (last write wins), so splitting them
 * across two `bind` calls (the env key and the ContainerApplication's logical
 * id) dropped the namespace binding for exactly this shape. See the
 * "async container bound on env" cases in `Container.test.ts`.
 */
export const AsyncContainerWorker = Cloudflare.Worker("AsyncContainerWorker", {
  main: path.resolve(import.meta.dirname, "worker.ts"),
  env: {
    ECHO: Cloudflare.Container<AsyncEchoObject>("ECHO", {
      className: "AsyncEchoObject",
      image: "mendhak/http-https-echo:latest",
      observability: { logs: { enabled: true } },
    }),
  },
});

export default Alchemy.Stack(
  "AsyncContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* AsyncContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
