import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { ManagedThing } from "./ManagedThing.ts";

/**
 * Shared scaffolding for the AWS IoT Managed Integrations HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action list, and (for the
 * thing-scoped builder) the injected identifier field is boilerplate.
 */

/**
 * Build the impl Effect for an operation scoped to one {@link ManagedThing}.
 * The deploy-time half grants `iamActions` on the bound thing's ARN; the
 * runtime half injects the thing's service-generated id into the request
 * under `key` (the API is split between `Identifier` and `ManagedThingId`
 * request fields).
 */
export const makeManagedThingHttpBinding = <
  I extends object,
  A,
  E,
  R,
  K extends "Identifier" | "ManagedThingId",
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"SendManagedThingCommand"`.
   */
  capability: string;
  /** IAM actions granted on the bound managed thing's ARN. */
  iamActions: readonly string[];
  /** The distilled operation; the field named `key` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** Request field that carries the bound thing's id. */
  key: K;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (thing: ManagedThing) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const ManagedThingId = yield* thing.managedThingId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.IoTManagedIntegrations.${options.capability}(${thing}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: [thing.managedThingArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.IoTManagedIntegrations.${options.capability}(${thing.LogicalId})`,
      )(function* (request?: Omit<I, K>) {
        return yield* op({
          ...request,
          [options.key]: yield* ManagedThingId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level IoT Managed Integrations
 * operation (device discovery, the schema catalog, the custom endpoint, and
 * connector events — per the `iotmanagedintegrations` service authorization
 * reference these authorize account-wide, so the grant is on
 * `Resource: ["*"]`).
 */
export const makeManagedIntegrationsHttpBinding = <
  I extends object,
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"StartDeviceDiscovery"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.IoTManagedIntegrations.${options.capability}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.IoTManagedIntegrations.${options.capability}`)(
        function* (request?: I) {
          return yield* op((request ?? {}) as I);
        },
      );
    });
  });
