import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as path from "pathe";
import type { Probe } from "./worker.ts";

/**
 * The "Bind on an async Worker" shape from the Containers guide, exactly as
 * issue #1321 reported it: one name for the env key, the Container's logical
 * id AND the Durable Object class — `className` omitted, so it defaults to
 * the env key.
 *
 * Distinct from `fixtures/async` (which names a class that differs from the
 * env key): with all three names equal there is nothing left to tell the
 * Worker's `durable_object_namespace` binding and its `containers` metadata
 * apart, so this is the shape that collapsed under one `sid` and lost the
 * namespace binding (see "async container bound on env" in
 * `Container.test.ts`).
 */
export const InferredClassWorker = Cloudflare.Worker("InferredClassWorker", {
  main: path.resolve(import.meta.dirname, "worker.ts"),
  env: {
    Probe: Cloudflare.Container<Probe>("Probe", {
      image: "mendhak/http-https-echo:latest",
    }),
  },
});

export default Alchemy.Stack(
  "InferredClassContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* InferredClassWorker;
    return { url: worker.url.as<string>() };
  }),
);
