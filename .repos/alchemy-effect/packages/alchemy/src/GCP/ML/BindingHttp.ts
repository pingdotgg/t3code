import * as Effect from "effect/Effect";
import type { Model } from "./Model.ts";
import type { ModelsVersion } from "./ModelsVersion.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for AI Platform (legacy ML Engine) bindings.
 * NOT exported from index.ts.
 */
export const makeModelHttpBinding = <
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
    return Effect.fn(function* (model: Model) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: model,
        iam: [grantFor(options.iam, model.name)],
      });
      const name = yield* model.name;
      return Effect.fn(`${options.tag}(${model.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

/**
 * Versions have no IAM policy of their own; `iam.on` (`ml.model`) is
 * granted on the version's parent model.
 */
export const makeVersionHttpBinding = <
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
    return Effect.fn(function* (version: ModelsVersion) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: version,
        iam: [grantFor(options.iam, version.model)],
      });
      const name = yield* version.name;
      return Effect.fn(`${options.tag}(${version.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
