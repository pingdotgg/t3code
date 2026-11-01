import * as Effect from "effect/Effect";
import type { ParametersVersion } from "./ParametersVersion.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Parameter Manager version bindings.
 * NOT exported from index.ts.
 */
export const makeParameterVersionHttpBinding = <I, A, E, Req = void>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
  toInput: (versionName: string, request: Req | undefined) => I;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (version: ParametersVersion) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: version,
        iam: [grantFor(options.iam, version.name)],
      });
      const name = yield* version.name;
      return Effect.fn(`${options.tag}(${version.LogicalId})`)(function* (
        request?: Req,
      ) {
        return yield* run(options.toInput(yield* name, request));
      });
    });
  });
