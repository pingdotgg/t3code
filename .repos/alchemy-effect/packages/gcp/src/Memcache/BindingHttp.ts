import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Shared HTTP scaffolding for Memorystore Memcached instance bindings.
 * NOT exported from index.ts.
 */
export const makeMemcacheInstanceHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (instance: Instance) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${instance})`({
          iam: [grantFor(options.iam, instance.name)],
        });
      }
      const name = yield* instance.name;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
