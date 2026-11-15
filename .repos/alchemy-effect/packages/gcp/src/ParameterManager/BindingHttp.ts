import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { ParametersVersion } from "./ParametersVersion.ts";

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
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (version: ParametersVersion) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${version})`({
          iam: [grantFor(options.iam, version.name)],
        });
      }
      const name = yield* version.name;
      return Effect.fn(`${options.tag}(${version.LogicalId})`)(function* (request?: Req) {
        return yield* run(options.toInput(yield* name, request));
      });
    });
  });
