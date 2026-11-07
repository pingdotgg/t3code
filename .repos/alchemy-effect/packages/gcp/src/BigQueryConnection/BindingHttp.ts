import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Connection } from "./Connection.ts";

/**
 * Shared HTTP scaffolding for BigQuery Connection bindings.
 * NOT exported from index.ts.
 */
export const makeConnectionHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (connection: Connection) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${connection})`({
          iam: [grantFor(options.iam, connection.name)],
        });
      }
      const name = yield* connection.name;
      return Effect.fn(`${options.tag}(${connection.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
