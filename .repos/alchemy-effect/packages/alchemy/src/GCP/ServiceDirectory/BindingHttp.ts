import * as Effect from "effect/Effect";
import type { Endpoint } from "./Endpoint.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Service Directory endpoint bindings.
 * NOT exported from index.ts.
 */
export const makeEndpointHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (endpoint: Endpoint) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: endpoint,
        iam: [grantFor(options.iam, endpoint.service)],
      });
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
