import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  inFleetWiseRegion,
  readFleetWiseTags,
  retryObservation,
  retryWhileConflict,
  stableEquals,
  syncFleetWiseTags,
  toFleetWiseTagList,
} from "./internal.ts";

export interface SignalCatalogProps {
  /**
   * Name of the signal catalog. Must be 1-100 characters of
   * `[a-zA-Z0-9:_-]`. If omitted, a deterministic physical name is
   * generated. Changing the name replaces the catalog.
   */
  signalCatalogName?: string;
  /**
   * Human-readable description of the signal catalog.
   */
  description?: string;
  /**
   * Signal nodes forming the catalog's tree — branches, sensors,
   * actuators, attributes, structs and properties. Each node is one of the
   * union variants (`{ branch }`, `{ sensor }`, ...) keyed by
   * `fullyQualifiedName`. Updated in place via
   * `nodesToAdd`/`nodesToUpdate`/`nodesToRemove` deltas.
   */
  nodes?: iotfleetwise.Node[];
  /**
   * User-defined tags for the signal catalog.
   */
  tags?: Record<string, string>;
}

export interface SignalCatalog extends Resource<
  "AWS.IoTFleetWise.SignalCatalog",
  SignalCatalogProps,
  {
    /** The name of the signal catalog. */
    signalCatalogName: string;
    /** The ARN of the signal catalog. */
    signalCatalogArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT FleetWise signal catalog — the account-wide collection of
 * standardized vehicle signals (branches, sensors, actuators, attributes)
 * that model manifests draw from.
 *
 * AWS IoT FleetWise is offered in `us-east-1` and `eu-central-1` only; the
 * provider follows the ambient region when supported and pins `us-east-1`
 * otherwise. Access to the service is allowlist-gated by AWS — accounts
 * without access receive `AccessDeniedException` on every operation.
 * @resource
 * @section Creating a Signal Catalog
 * @example Catalog with a Branch and a Sensor
 * ```typescript
 * const catalog = yield* SignalCatalog("Signals", {
 *   nodes: [
 *     { branch: { fullyQualifiedName: "Vehicle" } },
 *     {
 *       sensor: {
 *         fullyQualifiedName: "Vehicle.Speed",
 *         dataType: "DOUBLE",
 *         unit: "km/h",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Catalog with Attributes
 * ```typescript
 * const catalog = yield* SignalCatalog("Signals", {
 *   description: "vehicle signals",
 *   nodes: [
 *     { branch: { fullyQualifiedName: "Vehicle" } },
 *     {
 *       attribute: {
 *         fullyQualifiedName: "Vehicle.VIN",
 *         dataType: "STRING",
 *       },
 *     },
 *   ],
 *   tags: { team: "telemetry" },
 * });
 * ```
 */
export const SignalCatalog = Resource<SignalCatalog>(
  "AWS.IoTFleetWise.SignalCatalog",
);

const nodeFqn = (node: iotfleetwise.Node): string =>
  node.branch?.fullyQualifiedName ??
  node.sensor?.fullyQualifiedName ??
  node.actuator?.fullyQualifiedName ??
  node.attribute?.fullyQualifiedName ??
  node.struct?.fullyQualifiedName ??
  node.property?.fullyQualifiedName ??
  "";

export const SignalCatalogProvider = () =>
  Provider.effect(
    SignalCatalog,
    Effect.gen(function* () {
      const toName = (id: string, props: { signalCatalogName?: string }) =>
        props.signalCatalogName
          ? Effect.succeed(props.signalCatalogName)
          : createPhysicalName({ id, maxLength: 100 });

      const readCatalog = Effect.fn(function* (name: string) {
        return yield* iotfleetwise.getSignalCatalog({ name }).pipe(
          inFleetWiseRegion,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const readNodes = Effect.fn(function* (name: string) {
        return yield* iotfleetwise.listSignalCatalogNodes.items({ name }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          inFleetWiseRegion,
        );
      });

      return {
        stables: ["signalCatalogName", "signalCatalogArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.signalCatalogName ?? (yield* toName(id, olds ?? {}));
          const found = yield* readCatalog(name);
          if (found === undefined) return undefined;
          const attrs = {
            signalCatalogName: found.name,
            signalCatalogArn: found.arn,
          };
          const tags = yield* readFleetWiseTags(found.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.signalCatalogName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredNodes = news.nodes ?? [];

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readCatalog(name);

          // 2. Ensure — create if missing; tolerate the AlreadyExists race.
          if (observed === undefined) {
            yield* iotfleetwise
              .createSignalCatalog({
                name,
                description: news.description,
                nodes: desiredNodes,
                tags: toFleetWiseTagList(desiredTags),
              })
              .pipe(
                inFleetWiseRegion,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            observed = yield* readCatalog(name).pipe(
              Effect.flatMap((catalog) =>
                catalog === undefined
                  ? Effect.fail(new Error(`Signal catalog '${name}' not found`))
                  : Effect.succeed(catalog),
              ),
              retryObservation,
            );
          }

          // 3. Sync nodes + description — diff OBSERVED nodes against the
          //    desired tree keyed by fullyQualifiedName.
          const observedNodes = yield* readNodes(name);
          const observedByFqn = new Map(
            observedNodes.map((node) => [nodeFqn(node), node]),
          );
          const desiredByFqn = new Map(
            desiredNodes.map((node) => [nodeFqn(node), node]),
          );
          const nodesToAdd = desiredNodes.filter(
            (node) => !observedByFqn.has(nodeFqn(node)),
          );
          const nodesToUpdate = desiredNodes.filter((node) => {
            const current = observedByFqn.get(nodeFqn(node));
            return current !== undefined && !stableEquals(current, node);
          });
          const nodesToRemove = observedNodes
            .map(nodeFqn)
            .filter((fqn) => !desiredByFqn.has(fqn));
          const descriptionChanged =
            news.description !== undefined &&
            news.description !== observed.description;
          if (
            nodesToAdd.length > 0 ||
            nodesToUpdate.length > 0 ||
            nodesToRemove.length > 0 ||
            descriptionChanged
          ) {
            yield* iotfleetwise
              .updateSignalCatalog({
                name,
                description: descriptionChanged ? news.description : undefined,
                nodesToAdd: nodesToAdd.length > 0 ? nodesToAdd : undefined,
                nodesToUpdate:
                  nodesToUpdate.length > 0 ? nodesToUpdate : undefined,
                nodesToRemove:
                  nodesToRemove.length > 0 ? nodesToRemove : undefined,
              })
              .pipe(inFleetWiseRegion);
          }

          // 3b. Sync tags against OBSERVED cloud tags.
          yield* syncFleetWiseTags(observed.arn, desiredTags);

          yield* session.note(name);
          return {
            signalCatalogName: observed.name,
            signalCatalogArn: observed.arn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent: FleetWise deletes return success for missing
          // resources. Model manifests still detaching surface as
          // ConflictException — retry through the window (bounded).
          yield* iotfleetwise
            .deleteSignalCatalog({ name: output.signalCatalogName })
            .pipe(
              inFleetWiseRegion,
              retryWhileConflict,
              Effect.catchTag("ConflictException", () => Effect.void),
            );
        }),

        list: () =>
          iotfleetwise.listSignalCatalogs.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((summary) =>
                summary.name !== undefined && summary.arn !== undefined
                  ? [
                      {
                        signalCatalogName: summary.name,
                        signalCatalogArn: summary.arn,
                      },
                    ]
                  : [],
              ),
            ),
            inFleetWiseRegion,
          ),
      };
    }),
  );
