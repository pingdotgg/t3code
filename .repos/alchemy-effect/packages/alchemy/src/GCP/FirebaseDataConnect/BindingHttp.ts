import * as Effect from "effect/Effect";
import type { Service } from "./Service.ts";
import type { ServicesConnector } from "./ServicesConnector.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Firebase Data Connect bindings.
 * NOT exported from index.ts.
 */
export const makeServiceHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (service: Service) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: service,
        iam: [grantFor(options.iam, service.name)],
      });
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

export const makeConnectorHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (connector: ServicesConnector) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: connector,
        iam: [grantFor(options.iam, connector.name)],
      });
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
