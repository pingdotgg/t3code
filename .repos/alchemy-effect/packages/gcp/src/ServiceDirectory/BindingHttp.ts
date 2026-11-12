import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Endpoint } from "./Endpoint.ts";

/**
 * Shared HTTP scaffolding for Service Directory endpoint bindings.
 * NOT exported from index.ts.
 */
export const makeEndpointHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (endpoint: Endpoint) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${endpoint})`({
          iam: [grantFor(options.iam, endpoint.service)],
        });
      }
      const name = yield* endpoint.name;
      return Effect.fn(`${options.tag}(${endpoint.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
