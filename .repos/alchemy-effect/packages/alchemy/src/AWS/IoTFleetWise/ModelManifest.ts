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
  syncFleetWiseTags,
  toFleetWiseTagList,
} from "./internal.ts";

export interface ModelManifestProps {
  /**
   * Name of the model manifest. Must be 1-100 characters of
   * `[a-zA-Z0-9:_-]`. If omitted, a deterministic physical name is
   * generated. Changing the name replaces the manifest.
   */
  modelManifestName?: string;
  /**
   * ARN of the {@link SignalCatalog} the manifest's nodes come from.
   * Changing the signal catalog replaces the manifest.
   */
  signalCatalogArn: string;
  /**
   * Fully qualified names of the signal-catalog nodes included in the
   * vehicle model, e.g. `["Vehicle.Speed"]`. Updated in place via
   * `nodesToAdd`/`nodesToRemove` deltas (only while the manifest is in
   * `DRAFT` status).
   */
  nodes: string[];
  /**
   * Human-readable description of the model manifest.
   */
  description?: string;
  /**
   * Status of the manifest. Vehicles can only be created from an `ACTIVE`
   * manifest; node changes require `DRAFT`.
   * @default "DRAFT"
   */
  status?: "ACTIVE" | "DRAFT";
  /**
   * User-defined tags for the model manifest.
   */
  tags?: Record<string, string>;
}

export interface ModelManifest extends Resource<
  "AWS.IoTFleetWise.ModelManifest",
  ModelManifestProps,
  {
    /** The name of the model manifest. */
    modelManifestName: string;
    /** The ARN of the model manifest. */
    modelManifestArn: string;
    /** The current status of the manifest (`ACTIVE`, `DRAFT`, ...). */
    status: string;
    /** The signal catalog the manifest's nodes come from. */
    signalCatalogArn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT FleetWise model manifest (vehicle model) — the subset of
 * signal-catalog nodes that describes one vehicle type.
 *
 * A manifest is created in `DRAFT` status; set `status: "ACTIVE"` to make
 * it usable by decoder manifests and vehicles. AWS IoT FleetWise is
 * allowlist-gated and offered in `us-east-1`/`eu-central-1` only.
 * @resource
 * @section Creating a Model Manifest
 * @example Active Vehicle Model
 * ```typescript
 * const model = yield* ModelManifest("SedanModel", {
 *   signalCatalogArn: catalog.signalCatalogArn,
 *   nodes: ["Vehicle.Speed"],
 *   status: "ACTIVE",
 * });
 * ```
 *
 * @example Draft Model with Description
 * ```typescript
 * const model = yield* ModelManifest("SedanModel", {
 *   signalCatalogArn: catalog.signalCatalogArn,
 *   nodes: ["Vehicle.Speed", "Vehicle.VIN"],
 *   description: "2026 sedan line",
 * });
 * ```
 */
export const ModelManifest = Resource<ModelManifest>(
  "AWS.IoTFleetWise.ModelManifest",
);

const nodeFqn = (node: iotfleetwise.Node): string =>
  node.branch?.fullyQualifiedName ??
  node.sensor?.fullyQualifiedName ??
  node.actuator?.fullyQualifiedName ??
  node.attribute?.fullyQualifiedName ??
  node.struct?.fullyQualifiedName ??
  node.property?.fullyQualifiedName ??
  "";

export const ModelManifestProvider = () =>
  Provider.effect(
    ModelManifest,
    Effect.gen(function* () {
      const toName = (id: string, props: { modelManifestName?: string }) =>
        props.modelManifestName
          ? Effect.succeed(props.modelManifestName)
          : createPhysicalName({ id, maxLength: 100 });

      const readManifest = Effect.fn(function* (name: string) {
        return yield* iotfleetwise.getModelManifest({ name }).pipe(
          inFleetWiseRegion,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const readNodeFqns = Effect.fn(function* (name: string) {
        const nodes = yield* iotfleetwise.listModelManifestNodes
          .items({ name })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            inFleetWiseRegion,
          );
        return nodes.map(nodeFqn);
      });

      const toAttrs = (manifest: iotfleetwise.GetModelManifestResponse) => ({
        modelManifestName: manifest.name,
        modelManifestArn: manifest.arn,
        status: manifest.status ?? "DRAFT",
        signalCatalogArn: manifest.signalCatalogArn,
      });

      return {
        stables: ["modelManifestName", "modelManifestArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
          // The update API cannot change the signal catalog.
          if (news.signalCatalogArn !== olds.signalCatalogArn) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.modelManifestName ?? (yield* toName(id, olds ?? {}));
          const found = yield* readManifest(name);
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readFleetWiseTags(found.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.modelManifestName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredStatus = news.status ?? "DRAFT";

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readManifest(name);

          // 2. Ensure — create if missing; tolerate the AlreadyExists race.
          if (observed === undefined) {
            yield* iotfleetwise
              .createModelManifest({
                name,
                nodes: news.nodes,
                signalCatalogArn: news.signalCatalogArn,
                description: news.description,
                tags: toFleetWiseTagList(desiredTags),
              })
              .pipe(
                inFleetWiseRegion,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            observed = yield* readManifest(name).pipe(
              Effect.flatMap((manifest) =>
                manifest === undefined
                  ? Effect.fail(new Error(`Model manifest '${name}' not found`))
                  : Effect.succeed(manifest),
              ),
              retryObservation,
            );
          }

          // 3. Sync nodes + description — diff OBSERVED node FQNs against
          //    the desired list. Node changes require DRAFT status, so they
          //    are applied before any DRAFT -> ACTIVE transition.
          const observedFqns = yield* readNodeFqns(name);
          const observedSet = new Set(observedFqns);
          const desiredSet = new Set(news.nodes);
          const nodesToAdd = news.nodes.filter((n) => !observedSet.has(n));
          const nodesToRemove = observedFqns.filter((n) => !desiredSet.has(n));
          const descriptionChanged =
            news.description !== undefined &&
            news.description !== observed.description;
          if (
            nodesToAdd.length > 0 ||
            nodesToRemove.length > 0 ||
            descriptionChanged
          ) {
            yield* iotfleetwise
              .updateModelManifest({
                name,
                description: descriptionChanged ? news.description : undefined,
                nodesToAdd: nodesToAdd.length > 0 ? nodesToAdd : undefined,
                nodesToRemove:
                  nodesToRemove.length > 0 ? nodesToRemove : undefined,
              })
              .pipe(inFleetWiseRegion);
            observed = yield* readManifest(name).pipe(
              Effect.flatMap((manifest) =>
                manifest === undefined
                  ? Effect.fail(new Error(`Model manifest '${name}' not found`))
                  : Effect.succeed(manifest),
              ),
              retryObservation,
            );
          }

          // 3b. Sync status (e.g. activate a draft).
          if ((observed.status ?? "DRAFT") !== desiredStatus) {
            yield* iotfleetwise
              .updateModelManifest({ name, status: desiredStatus })
              .pipe(inFleetWiseRegion);
            observed = yield* readManifest(name).pipe(
              Effect.flatMap((manifest) =>
                manifest === undefined
                  ? Effect.fail(new Error(`Model manifest '${name}' not found`))
                  : Effect.succeed(manifest),
              ),
              retryObservation,
            );
          }

          // 3c. Sync tags against OBSERVED cloud tags.
          yield* syncFleetWiseTags(observed.arn, desiredTags);

          yield* session.note(name);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent: deleting a missing manifest succeeds. Decoder
          // manifests still detaching surface as ConflictException — retry
          // through the window (bounded).
          yield* iotfleetwise
            .deleteModelManifest({ name: output.modelManifestName })
            .pipe(
              inFleetWiseRegion,
              retryWhileConflict,
              Effect.catchTag("ConflictException", () => Effect.void),
            );
        }),

        list: () =>
          iotfleetwise.listModelManifests.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((summary) =>
                summary.name !== undefined && summary.arn !== undefined
                  ? [
                      {
                        modelManifestName: summary.name,
                        modelManifestArn: summary.arn,
                        status: summary.status ?? "DRAFT",
                        signalCatalogArn: summary.signalCatalogArn,
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
