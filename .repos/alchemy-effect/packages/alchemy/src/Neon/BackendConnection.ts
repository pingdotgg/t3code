import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import type { Resource, ResourceLike } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

export const backendEnvKey = (id: string, field: string) =>
  `NEON_BINDING_${Array.from(id, (char) => char.codePointAt(0)!.toString(16)).join("_")}_${field}`;

type EnvValue = string | Redacted.Redacted<string>;
type EnvHost = Resource<
  string,
  object | undefined,
  object,
  { env?: Record<string, Output.Output<EnvValue>> }
>;
type TextBinding = {
  type: "plain_text" | "secret_text";
  name: string;
  text: string;
};
type WorkerHost = Resource<
  "Cloudflare.Worker",
  object | undefined,
  object,
  { bindings?: TextBinding[] }
>;

const isEnvHost = (host: ResourceLike | undefined): host is EnvHost =>
  host?.Type === "Neon.Function" ||
  host?.Type === "AWS.Lambda.Function" ||
  host?.Type === "Prisma.Compute" ||
  host?.Type === "Cloudflare.Container";
const isWorkerHost = (host: ResourceLike | undefined): host is WorkerHost =>
  host?.Type === "Cloudflare.Worker";

export const bindBackendEnvironment = Effect.fn(function* (
  id: string,
  env: Record<string, Output.Output<EnvValue>>,
) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const host = yield* Binding.Host;
  if (isEnvHost(host)) {
    yield* host.bind(id, { env });
  } else if (isWorkerHost(host)) {
    yield* host.bind(id, {
      bindings: Object.entries(env).map(([name, value]) =>
        value.pipe(
          Output.map((value): TextBinding => ({
            name,
            type: Redacted.isRedacted(value) ? "secret_text" : "plain_text",
            text: Redacted.isRedacted(value) ? Redacted.value(value) : value,
          })),
        ),
      ),
    });
  } else {
    return yield* Effect.die(
      new Error(
        `Neon connection binding does not support host ${host?.Type ?? "none"}`,
      ),
    );
  }
});

export const backendString = (
  key: string,
): Effect.Effect<string, never, RuntimeContext> =>
  Config.String(key).pipe(Effect.orDie);
export const backendSecret = (
  key: string,
): Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext> =>
  Config.Redacted(key).pipe(Effect.orDie);
