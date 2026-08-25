import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Output as OutputType } from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { inFleetWiseRegion } from "./internal.ts";

/**
 * Shared scaffolding for AWS IoT FleetWise HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeFleetWise…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation, the injected identifier,
 * and the IAM action list + granted ARNs is boilerplate. Every runtime call
 * is piped through {@link inFleetWiseRegion} because AWS IoT FleetWise is
 * offered only in `us-east-1`/`eu-central-1` — a Lambda running anywhere else
 * transparently calls the service's home region.
 */

/**
 * Build the impl Effect for a FleetWise operation scoped to one resource
 * (vehicle, fleet, campaign, or one of the manifests/catalogs): the
 * deploy-time half grants `actions` on `resources`, and the runtime callable
 * injects the bound resource's identifier as the `requestKey` field of every
 * request.
 */
export const makeFleetWiseResourceHttpBinding = <
  Res extends ResourceLike,
  K extends string,
  I extends { [P in K]: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IoTFleetWise.GetVehicleStatus`. */
  tag: string;
  /** The distilled operation; the identifier is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** The request field the bound resource's identifier is injected as. */
  requestKey: K;
  /**
   * Resolve the injected identifier from the bound resource. `Req` is pinned
   * to `never` (resource attributes are `Output<string, never>`): the default
   * `Output<string>` widens `Req` to `any`, which leaks into the per-resource
   * Effect's requirements and breaks the binding contract's `never`.
   */
  identifier: (resource: Res) => OutputType<string, never>;
  /** ARNs the actions are granted on. */
  resources: (resource: Res) => (OutputType<string> | string)[];
}) =>
  Effect.gen(function* () {
    // Capture the client in the FleetWise home region: yielding an
    // operation captures its services (region, credentials, HTTP client)
    // once, so the pin must wrap the capture, not the later calls.
    const op = yield* inFleetWiseRegion(options.operation);

    return Effect.fn(function* (resource: Res) {
      const Identifier = yield* options.identifier(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${resource}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: options.resources(resource),
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        return yield* op({
          ...request,
          [options.requestKey]: yield* Identifier,
        } as unknown as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level FleetWise operation (no bound
 * resource): the deploy-time half grants `actions` on `resources`
 * (default `*` — batch vehicle operations authorize on vehicle ARNs that
 * only exist at runtime), and the runtime callable passes the caller's
 * request through unchanged.
 */
export const makeFleetWiseAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.IoTFleetWise.ListVehicles`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /**
   * ARN patterns the actions are granted on.
   * @default ["*"]
   */
  resources?: readonly string[];
}) =>
  Effect.gen(function* () {
    // See makeFleetWiseResourceHttpBinding: the region pin wraps the
    // service capture, not the later calls.
    const op = yield* inFleetWiseRegion(options.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [...(options.resources ?? ["*"])],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
