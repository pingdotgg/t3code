import * as Effect from "effect/Effect";
import type { CatalogsServingConfig } from "./CatalogsServingConfig.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Retail serving-config bindings.
 * NOT exported from index.ts.
 */
export const makeServingConfigHttpBinding = <
  I extends { placement: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (servingConfig: CatalogsServingConfig) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: servingConfig,
        iam: [grantFor(options.iam, servingConfig.name)],
      });
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
