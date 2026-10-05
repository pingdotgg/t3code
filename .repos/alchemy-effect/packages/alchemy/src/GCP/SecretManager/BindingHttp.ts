import * as Effect from "effect/Effect";
import type { LocationsSecret } from "./LocationsSecret.ts";
import type { Secret } from "./Secret.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";

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
    const run = yield* options.operation;
    return Effect.fn(function* (secret: SecretBindingTarget) {
      // `name` is `projects/p/secrets/s` or, for regional secrets,
      // `projects/p/locations/l/secrets/s`; both are secret IAM targets.
      yield* bindGcpHost({
        tag: options.tag,
        resource: secret,
        iam: [grantFor(options.iam, secret.name)],
      });
      const name = yield* secret.name;
      return Effect.fn(`${options.tag}(${secret.LogicalId})`)(function* (
        request?: Req,
      ) {
        return yield* run(options.toInput(yield* name, request));
      });
    });
  });
