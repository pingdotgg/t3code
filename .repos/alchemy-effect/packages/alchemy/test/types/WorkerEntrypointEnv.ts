import * as Cloudflare from "@/Cloudflare";
import type { Rpc } from "@/Rpc.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import type * as Effect from "effect/Effect";

declare class Api extends WorkerEntrypoint<unknown, Record<string, unknown>> {
  greet(name: string): Promise<string>;
  count(): number;
}

declare const target: Cloudflare.Worker;
declare const effectTarget: Cloudflare.Worker &
  Rpc<{ defaultOnly(): Effect.Effect<string> }>;

export const Worker = Cloudflare.Worker("EntrypointEnvTypeProbe", {
  script: "export default {}",
  env: {
    API: Cloudflare.WorkerEntrypoint<Api>(target, "Api"),
    OPTIONS: Cloudflare.WorkerEntrypoint<Api>(target, {
      entrypoint: "Api",
      props: { tenant: "acme" },
    }),
    UNTYPED: Cloudflare.WorkerEntrypoint(target, "Api"),
    DEFAULT: Cloudflare.WorkerEntrypoint(target),
    NAMED_ON_EFFECT: Cloudflare.WorkerEntrypoint(effectTarget, "Api"),
    DIRECT_EFFECT: effectTarget,
  },
});

type Env = Cloudflare.InferEnv<typeof Worker>;
declare const env: Env;

export const _greeting: Promise<string> = env.API.greet("alice");
export const _count: Promise<number> = env.API.count();
export const _options: Promise<string> = env.OPTIONS.greet("alice");
export const _fetched: Promise<Response> = env.API.fetch("https://example.com");
export const _connected: Socket = env.API.connect("example.com:443");
export const _directEffect: Promise<string | Cloudflare.RpcErrorEnvelope> =
  env.DIRECT_EFFECT.defaultOnly();

// @ts-expect-error RPC promisifies synchronous methods.
export const _syncCount: number = env.API.count();
// @ts-expect-error Arguments are checked against the entrypoint.
env.API.greet(123);
// @ts-expect-error Unknown methods are not exposed.
env.API.missing();
// @ts-expect-error The entrypoint's protected context is not exposed.
env.API.ctx;
// @ts-expect-error The entrypoint's protected environment is not exposed.
env.API.env;

export const _untyped: Promise<Response> = env.UNTYPED.fetch(
  "https://example.com",
);
export const _default: Promise<Response> = env.DEFAULT.fetch(
  "https://example.com",
);
// @ts-expect-error Untyped bindings expose only the Fetcher interface.
env.UNTYPED.greet("alice");
// @ts-expect-error A named entrypoint does not inherit the default entrypoint's methods.
env.NAMED_ON_EFFECT.defaultOnly();

// @ts-expect-error Use the entrypoint instance type, not its constructor.
Cloudflare.WorkerEntrypoint<typeof Api>(target, "Api");
// @ts-expect-error Plain method bags are not native Worker entrypoints.
Cloudflare.WorkerEntrypoint<{ count(): number }>(target, "Api");
// @ts-expect-error Effect-native Workers use their existing direct binding types.
Cloudflare.WorkerEntrypoint<typeof effectTarget>(target, "Api");
