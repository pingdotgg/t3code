import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { EventDataStore } from "./EventDataStore.ts";

/**
 * Shared scaffolding for AWS CloudTrail HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation, the IAM action list, and (for
 * Lake operations) the injected event data store is boilerplate.
 */

/**
 * Build the impl Effect for a CloudTrail Lake operation scoped to an
 * {@link EventDataStore}: the deploy-time half grants `actions` on the bound
 * store's ARN. Query operations are keyed by `QueryId` and need no request
 * injection; list/generate operations reference the store in the request via
 * `injectEventDataStore` / `injectEventDataStores`.
 */
export const makeCloudTrailEventDataStoreHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CloudTrail.GetQueryResults`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the event data store ARN. */
  actions: readonly string[];
  /** Inject the bound store's ARN as the request's `EventDataStore` field. */
  injectEventDataStore?: boolean;
  /** Inject the bound store's ARN as the request's `EventDataStores` list. */
  injectEventDataStores?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (store: EventDataStore) {
      const Arn = yield* store.eventDataStoreArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${store}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [store.eventDataStoreArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${store.LogicalId})`)(function* (
        request?: Omit<I, "EventDataStore" | "EventDataStores">,
      ) {
        const arn = yield* Arn;
        return yield* op({
          ...request,
          ...(options.injectEventDataStore ? { EventDataStore: arn } : {}),
          ...(options.injectEventDataStores ? { EventDataStores: [arn] } : {}),
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level CloudTrail operation (event
 * history lookup, digest public keys, Insights metrics). The deploy-time
 * half grants `actions` on `*` — these CloudTrail actions are not
 * resource-scoped.
 */
export const makeCloudTrailAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CloudTrail.LookupEvents`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
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
