/**
 * Shared scaffolding for the GitHub `*Local` binding layers: the same
 * operations as `*Http`, authenticated with the provider's current
 * credentials instead of a token bound into a host. Provide them on an
 * `Action` or any deploy-time Effect.
 *
 * NOT exported from `index.ts`.
 */
import * as Effect from "effect/Effect";
import { type Operation, makeOperationClient } from "./BindingHttp.ts";
import { Credentials } from "./Credentials.ts";

export const make = <Request extends ReadonlyArray<any>, Out, E>(op: Operation<Request, Out, E>) =>
  Effect.gen(function* () {
    const credentials = yield* yield* Credentials;
    return makeOperationClient(op, {
      token: Effect.succeed(credentials.token),
      apiUrl: Effect.succeed(credentials.apiBaseUrl),
    });
  });
