import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { GeofenceCollection } from "./GeofenceCollection.ts";
import type { Map as LocationMap } from "./Map.ts";
import type { PlaceIndex } from "./PlaceIndex.ts";
import type { RouteCalculator } from "./RouteCalculator.ts";
import type { Tracker } from "./Tracker.ts";

/**
 * Shared scaffolding for the Amazon Location Service runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeLocation…HttpBinding({ … }))` over one of the
 * builders below. Everything except the operation and the IAM action list is
 * boilerplate: each data-plane operation is scoped to exactly one Location
 * resource (tracker, geofence collection, place index, route calculator, or
 * map), whose physical name is injected into the request and whose ARN
 * receives the grant. Batch metadata jobs are account-scoped.
 */

/**
 * Build the impl Effect for a tracker-scoped Location operation: the runtime
 * callable injects the bound {@link Tracker}'s name as `TrackerName` and the
 * deploy-time half grants `actions` on the tracker ARN.
 */
export const makeLocationTrackerHttpBinding = <
  I extends { TrackerName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Location.GetDevicePosition`. */
  tag: string;
  /** The distilled operation; `TrackerName` is injected from the tracker. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the tracker ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (tracker: Tracker) {
      const TrackerName = yield* tracker.trackerName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${tracker}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${tracker.trackerArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${tracker.LogicalId})`)(function* (
        request?: Omit<I, "TrackerName">,
      ) {
        return yield* op({
          ...request,
          TrackerName: yield* TrackerName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a geofence-collection-scoped Location operation:
 * the runtime callable injects the bound {@link GeofenceCollection}'s name as
 * `CollectionName` and the deploy-time half grants `actions` on the
 * collection ARN.
 */
export const makeLocationCollectionHttpBinding = <
  I extends { CollectionName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Location.PutGeofence`. */
  tag: string;
  /** The distilled operation; `CollectionName` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the geofence collection ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (collection: GeofenceCollection) {
      const CollectionName = yield* collection.collectionName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${collection}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${collection.collectionArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${collection.LogicalId})`)(function* (
        request?: Omit<I, "CollectionName">,
      ) {
        return yield* op({
          ...request,
          CollectionName: yield* CollectionName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a place-index-scoped Location operation: the
 * runtime callable injects the bound {@link PlaceIndex}'s name as `IndexName`
 * and the deploy-time half grants `actions` on the index ARN.
 */
export const makeLocationPlaceIndexHttpBinding = <
  I extends { IndexName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Location.SearchPlaceIndexForText`. */
  tag: string;
  /** The distilled operation; `IndexName` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the place index ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (index: PlaceIndex) {
      const IndexName = yield* index.indexName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${index}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${index.indexArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${index.LogicalId})`)(function* (
        request?: Omit<I, "IndexName">,
      ) {
        return yield* op({
          ...request,
          IndexName: yield* IndexName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a route-calculator-scoped Location operation: the
 * runtime callable injects the bound {@link RouteCalculator}'s name as
 * `CalculatorName` and the deploy-time half grants `actions` on the
 * calculator ARN.
 */
export const makeLocationCalculatorHttpBinding = <
  I extends { CalculatorName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Location.CalculateRoute`. */
  tag: string;
  /** The distilled operation; `CalculatorName` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the route calculator ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (calculator: RouteCalculator) {
      const CalculatorName = yield* calculator.calculatorName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${calculator}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${calculator.calculatorArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${calculator.LogicalId})`)(function* (
        request?: Omit<I, "CalculatorName">,
      ) {
        return yield* op({
          ...request,
          CalculatorName: yield* CalculatorName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a map-scoped Location operation: the runtime
 * callable injects the bound {@link LocationMap}'s name as `MapName` and the
 * deploy-time half grants `actions` on the map ARN.
 */
export const makeLocationMapHttpBinding = <
  I extends { MapName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Location.GetMapTile`. */
  tag: string;
  /** The distilled operation; `MapName` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the map ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (map: LocationMap) {
      const MapName = yield* map.mapName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${map}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${map.mapArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${map.LogicalId})`)(function* (
        request?: Omit<I, "MapName">,
      ) {
        return yield* op({
          ...request,
          MapName: yield* MapName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-scoped Location operation (the batch
 * metadata jobs API: `ListJobs`, `GetJob`, `CancelJob`): jobs are created at
 * runtime so their ARNs are unknowable at deploy time — the deploy-time half
 * grants `actions` on `*`.
 */
export const makeLocationAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Location.ListJobs`. */
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
