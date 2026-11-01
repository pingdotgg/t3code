import type { Config } from "@distilled.cloud/hetzner";
import { Credentials } from "@distilled.cloud/hetzner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Fully-resolved Hetzner Cloud environment for a stack.
 *
 * A Hetzner Cloud token is issued per project — the token IS the project
 * scope, so this service only carries `{ token, apiBaseUrl }`. Resolve
 * it inside lifecycle operations with `HetznerEnvironment.current`.
 */
export type HetznerEnvironmentShape = Config;

export class HetznerEnvironment extends Context.Service<
  HetznerEnvironment,
  Effect.Effect<HetznerEnvironmentShape>
>()("Hetzner::Environment") {
  static current = HetznerEnvironment.use((env) => env);
  readonly kind = "Environment" as const;
}

/**
 * Build a `HetznerEnvironment` layer from the distilled `Credentials`
 * service. Provide this after `Credentials.fromAuthProvider()`.
 */
export const fromCredentials = () =>
  Layer.effect(
    HetznerEnvironment,
    Effect.gen(function* () {
      return yield* Credentials;
    }),
  );
