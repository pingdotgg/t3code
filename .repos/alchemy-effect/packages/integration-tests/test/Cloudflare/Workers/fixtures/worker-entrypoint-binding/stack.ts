import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import type { Api } from "./entrypoint-target-worker.ts";

const targetMain = pathe.resolve(import.meta.dirname, "entrypoint-target-worker.ts");
const callerMain = pathe.resolve(import.meta.dirname, "entrypoint-caller-worker.ts");

export const Target = () =>
  Cloudflare.Worker("EntrypointTarget", {
    main: targetMain,
    env: {
      SELF: Cloudflare.WorkerEntrypoint<Api>({
        entrypoint: "Api",
        props: { tenant: "self" },
      }),
      SELF_DEFAULT: Cloudflare.WorkerEntrypoint(),
    },
  });

export const Caller = (target: Cloudflare.Worker) =>
  Cloudflare.Worker("EntrypointCaller", {
    main: callerMain,
    env: {
      API: Cloudflare.WorkerEntrypoint<Api>(target, {
        entrypoint: "Api",
        props: { tenant: "acme" },
      }),
    },
  });

export type CallerEnv = Cloudflare.InferEnv<ReturnType<typeof Caller>>;

/**
 * Stack with two plain Workers:
 *
 * - `EntrypointTarget` — exports a named `Api` entrypoint (greet + a
 *   ctx.props echo) alongside its default handler, and binds its own `Api`
 *   via `Cloudflare.WorkerEntrypoint({ entrypoint: "Api", props })`.
 * - `EntrypointCaller` — binds the target's `Api` entrypoint via
 *   `Cloudflare.WorkerEntrypoint(target, { entrypoint: "Api", props })`.
 */
export default Alchemy.Stack(
  "WorkerEntrypointBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const target = yield* Target();

    const caller = yield* Caller(target);

    return {
      targetUrl: target.url.as<string>(),
      callerUrl: caller.url.as<string>(),
    };
  }),
);
