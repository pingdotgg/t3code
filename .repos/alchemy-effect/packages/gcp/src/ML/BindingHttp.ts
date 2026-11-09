import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { Model } from "./Model.ts";
import type { ModelsVersion } from "./ModelsVersion.ts";

/**
 * Shared HTTP scaffolding for AI Platform (legacy ML Engine) bindings.
 * NOT exported from index.ts.
 */
export const makeModelHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (model: Model) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${model})`({
          iam: [grantFor(options.iam, model.name)],
        });
      }
      const name = yield* model.name;
      return Effect.fn(`${options.tag}(${model.LogicalId})`)(function* (request?: Omit<I, "name">) {
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
export const makeVersionHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (version: ModelsVersion) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${version})`({
          iam: [grantFor(options.iam, version.model)],
        });
      }
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
