import type { Output } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Oracle Database@Google Cloud bindings.
 * NOT exported from index.ts.
 */
export const makeOracleNameHttpBinding = <
  Resource extends {
    readonly name: Output<string, never>;
    readonly LogicalId: string;
  },
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  /** Oracle Database@Google Cloud has no resource-level IAM: project grant. */
  iam: Pick<BindingIam, "role">;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (resource: Resource) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${resource})`({ iam: [{ role: options.iam.role }] });
      }
      const name = yield* resource.name;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
