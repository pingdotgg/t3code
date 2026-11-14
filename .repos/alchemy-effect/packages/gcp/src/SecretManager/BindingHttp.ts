import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { LocationsSecret } from "./LocationsSecret.ts";
import type { Secret } from "./Secret.ts";

export type SecretBindingTarget = Secret | LocationsSecret;

/**
 * Shared HTTP scaffolding for Secret Manager bindings.
 * NOT exported from index.ts.
 */
export const makeSecretHttpBinding = <I, A, E, Req = void>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
  toInput: (secretName: string, request: Req | undefined) => I;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (secret: SecretBindingTarget) {
      // `name` is `projects/p/secrets/s` or, for regional secrets,
      // `projects/p/locations/l/secrets/s`; both are secret IAM targets.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${secret})`({
          iam: [grantFor(options.iam, secret.name)],
        });
      }
      const name = yield* secret.name;
      return Effect.fn(`${options.tag}(${secret.LogicalId})`)(function* (request?: Req) {
        return yield* run(options.toInput(yield* name, request));
      });
    });
  });
