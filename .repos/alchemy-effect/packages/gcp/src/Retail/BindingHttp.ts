import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { CatalogsServingConfig } from "./CatalogsServingConfig.ts";

/**
 * Shared HTTP scaffolding for Retail serving-config bindings.
 * NOT exported from index.ts.
 */
export const makeServingConfigHttpBinding = <I extends { placement: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (servingConfig: CatalogsServingConfig) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${servingConfig})`({
          iam: [grantFor(options.iam, servingConfig.name)],
        });
      }
      const name = yield* servingConfig.name;
      return Effect.fn(`${options.tag}(${servingConfig.LogicalId})`)(function* (
        request: Omit<I, "placement">,
      ) {
        return yield* run({
          ...request,
          placement: yield* name,
        } as I);
      });
    });
  });
