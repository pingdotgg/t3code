import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Shared HTTP scaffolding for Compute Engine instance bindings.
 * NOT exported from index.ts.
 */
export const makeInstanceHttpBinding = <
  I extends { instance?: string; zone?: string; project?: string },
  A,
  E,
>(options: {
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
          iam: [
            grantFor(
              options.iam,
              Output.interpolate`projects/${instance.project}/zones/${instance.zone}/instances/${instance.instanceName}`,
            ),
          ],
        });
      }
      const instanceName = yield* instance.instanceName;
      const zone = yield* instance.zone;
      const project = yield* instance.project;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "instance" | "zone" | "project">,
      ) {
        return yield* run({
          ...(request as I),
          instance: yield* instanceName,
          zone: yield* zone,
          project: yield* project,
        } as I);
      });
    });
  });
