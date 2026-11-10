import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Service } from "./Service.ts";
import type { ServicesConnector } from "./ServicesConnector.ts";

/**
 * Shared HTTP scaffolding for Firebase Data Connect bindings.
 * NOT exported from index.ts.
 */
export const makeServiceHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (service: Service) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${service})`({
          iam: [grantFor(options.iam, service.name)],
        });
      }
      const name = yield* service.name;
      return Effect.fn(`${options.tag}(${service.LogicalId})`)(function* (
        request: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });

export const makeConnectorHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (connector: ServicesConnector) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${connector})`({
          iam: [grantFor(options.iam, connector.name)],
        });
      }
      const name = yield* connector.name;
      return Effect.fn(`${options.tag}(${connector.LogicalId})`)(function* (
        request: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });
