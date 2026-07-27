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
  stableEquals,
  syncFleetWiseTags,
  toFleetWiseTagList,
} from "./internal.ts";

export interface VehicleProps {
  /**
   * Name of the vehicle. Must be 1-100 characters of `[a-zA-Z0-9:_-]` and
   * match the corresponding AWS IoT thing name. If omitted, a
   * deterministic physical name is generated. Changing the name replaces
   * the vehicle.
   */
  vehicleName?: string;
  /**
   * ARN of an `ACTIVE` {@link ModelManifest} the vehicle is modeled by.
   * Updated in place.
   */
  modelManifestArn: string;
  /**
   * ARN of an `ACTIVE` {@link DecoderManifest} associated with the model
   * manifest. Updated in place.
   */
  decoderManifestArn: string;
  /**
   * Static attribute values (key/value strings) for attributes defined in
   * the model manifest, e.g. `{ "Vehicle.VIN": "1HGBH..." }`. Synced in
   * place with `attributeUpdateMode: "Overwrite"`.
   */
  attributes?: Record<string, string>;
  /**
   * Whether to create a new AWS IoT thing for the vehicle
   * (`"CreateIotThing"`) or validate an existing thing
   * (`"ValidateIotThingExists"`). Applied at creation only; changing it
   * replaces the vehicle.
   * @default "CreateIotThing"
   */
  associationBehavior?: iotfleetwise.VehicleAssociationBehavior;
  /**
   * State templates associated with the vehicle — each pairs a
   * {@link StateTemplate} identifier (name or ARN) with an update strategy
   * (`{ onChange: {} }` or `{ periodic: { stateTemplateUpdateRate } }`).
   * Synced in place via add/remove/update deltas.
   */
  stateTemplates?: iotfleetwise.StateTemplateAssociation[];
  /**
   * User-defined tags for the vehicle.
   */
  tags?: Record<string, string>;
}

export interface Vehicle extends Resource<
  "AWS.IoTFleetWise.Vehicle",
  VehicleProps,
  {
    /** The name of the vehicle (also the backing IoT thing name). */
    vehicleName: string;
    /** The ARN of the vehicle. */
    vehicleArn: string;
    /** The model manifest the vehicle conforms to. */
    modelManifestArn: string;
    /** The decoder manifest the vehicle uses. */
    decoderManifestArn: string;
    /** The static attributes stored on the vehicle. */
    attributes: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT FleetWise vehicle — the digital twin of a physical vehicle,
 * created from an `ACTIVE` {@link ModelManifest} and
 * {@link DecoderManifest} pair and backed by an AWS IoT thing.
 * @resource
 * @section Creating a Vehicle
 * @example Vehicle with an Auto-Created IoT Thing
 * ```typescript
 * const vehicle = yield* Vehicle("TestVehicle", {
 *   modelManifestArn: model.modelManifestArn,
 *   decoderManifestArn: decoder.decoderManifestArn,
 * });
 * ```
 *
 * @example Vehicle with Attributes
 * ```typescript
 * const vehicle = yield* Vehicle("TestVehicle", {
 *   modelManifestArn: model.modelManifestArn,
 *   decoderManifestArn: decoder.decoderManifestArn,
 *   attributes: { "Vehicle.VIN": "1HGBH41JXMN109186" },
 *   tags: { plant: "fremont" },
 * });
 * ```
 */
export const Vehicle = Resource<Vehicle>("AWS.IoTFleetWise.Vehicle");

const toAttributeRecord = (
  attributes: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes ?? {}).flatMap(([key, value]) =>
      value !== undefined ? [[key, value]] : [],
    ),
  );

export const VehicleProvider = () =>
  Provider.effect(
    Vehicle,
    Effect.gen(function* () {
      const toName = (id: string, props: { vehicleName?: string }) =>
        props.vehicleName
          ? Effect.succeed(props.vehicleName)
          : createPhysicalName({ id, maxLength: 100 });

      const readVehicle = Effect.fn(function* (vehicleName: string) {
        return yield* iotfleetwise.getVehicle({ vehicleName }).pipe(
          inFleetWiseRegion,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const toAttrs = Effect.fn(function* (
        vehicle: iotfleetwise.GetVehicleResponse,
      ) {
        if (
          vehicle.vehicleName === undefined ||
          vehicle.arn === undefined ||
          vehicle.modelManifestArn === undefined ||
          vehicle.decoderManifestArn === undefined
        ) {
          return yield* Effect.fail(
            new Error(
              `Vehicle '${vehicle.vehicleName}' is missing required fields`,
            ),
          );
        }
        return {
          vehicleName: vehicle.vehicleName,
          vehicleArn: vehicle.arn,
          modelManifestArn: vehicle.modelManifestArn,
          decoderManifestArn: vehicle.decoderManifestArn,
          attributes: toAttributeRecord(vehicle.attributes),
        };
      });

      return {
        stables: ["vehicleName", "vehicleArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
          // The IoT-thing association is decided at creation time.
          if (
            (news.associationBehavior ?? "CreateIotThing") !==
            (olds.associationBehavior ?? "CreateIotThing")
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.vehicleName ?? (yield* toName(id, olds ?? {}));
          const found = yield* readVehicle(name);
          if (found?.arn === undefined) return undefined;
          const attrs = yield* toAttrs(found);
          const tags = yield* readFleetWiseTags(found.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.vehicleName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readVehicle(name);

          // 2. Ensure — create if missing; tolerate the AlreadyExists race.
          if (observed === undefined) {
            yield* iotfleetwise
              .createVehicle({
                vehicleName: name,
                modelManifestArn: news.modelManifestArn,
                decoderManifestArn: news.decoderManifestArn,
                attributes: news.attributes,
                associationBehavior:
                  news.associationBehavior ?? "CreateIotThing",
                stateTemplates: news.stateTemplates,
                tags: toFleetWiseTagList(desiredTags),
              })
              .pipe(
                inFleetWiseRegion,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            observed = yield* readVehicle(name).pipe(
              Effect.flatMap((vehicle) =>
                vehicle === undefined
                  ? Effect.fail(new Error(`Vehicle '${name}' not found`))
                  : Effect.succeed(vehicle),
              ),
              retryObservation,
            );
          }

          // 3. Sync manifests + attributes — apply only the observed delta.
          const manifestChanged =
            observed.modelManifestArn !== news.modelManifestArn ||
            observed.decoderManifestArn !== news.decoderManifestArn;
          const attributesChanged =
            news.attributes !== undefined &&
            !stableEquals(
              toAttributeRecord(observed.attributes),
              news.attributes,
            );
          if (manifestChanged || attributesChanged) {
            yield* iotfleetwise
              .updateVehicle({
                vehicleName: name,
                modelManifestArn: manifestChanged
                  ? news.modelManifestArn
                  : undefined,
                decoderManifestArn: manifestChanged
                  ? news.decoderManifestArn
                  : undefined,
                attributes: attributesChanged ? news.attributes : undefined,
                attributeUpdateMode: attributesChanged
                  ? "Overwrite"
                  : undefined,
              })
              .pipe(inFleetWiseRegion);
            observed = yield* readVehicle(name).pipe(
              Effect.flatMap((vehicle) =>
                vehicle === undefined
                  ? Effect.fail(new Error(`Vehicle '${name}' not found`))
                  : Effect.succeed(vehicle),
              ),
              retryObservation,
            );
          }

          // 3b. Sync state-template associations against OBSERVED state.
          // Associations are keyed by identifier; strategy changes are
          // applied via stateTemplatesToUpdate. Identifiers are matched
          // exactly (pass the same name-or-ARN form consistently).
          if (news.stateTemplates !== undefined) {
            const desired = news.stateTemplates;
            const observedAssociations = observed.stateTemplates ?? [];
            const observedByIdentifier = new Map(
              observedAssociations.map((a) => [a.identifier, a]),
            );
            const desiredIdentifiers = new Set(
              desired.map((a) => a.identifier),
            );
            const templatesToAdd = desired.filter(
              (a) => !observedByIdentifier.has(a.identifier),
            );
            const templatesToUpdate = desired.filter((a) => {
              const current = observedByIdentifier.get(a.identifier);
              return (
                current !== undefined &&
                !stableEquals(
                  current.stateTemplateUpdateStrategy,
                  a.stateTemplateUpdateStrategy,
                )
              );
            });
            const templatesToRemove = observedAssociations
              .filter((a) => !desiredIdentifiers.has(a.identifier))
              .map((a) => a.identifier);
            if (
              templatesToAdd.length > 0 ||
              templatesToUpdate.length > 0 ||
              templatesToRemove.length > 0
            ) {
              yield* iotfleetwise
                .updateVehicle({
                  vehicleName: name,
                  stateTemplatesToAdd:
                    templatesToAdd.length > 0 ? templatesToAdd : undefined,
                  stateTemplatesToUpdate:
                    templatesToUpdate.length > 0
                      ? templatesToUpdate
                      : undefined,
                  stateTemplatesToRemove:
                    templatesToRemove.length > 0
                      ? templatesToRemove
                      : undefined,
                })
                .pipe(inFleetWiseRegion);
              observed = yield* readVehicle(name).pipe(
                Effect.flatMap((vehicle) =>
                  vehicle === undefined
                    ? Effect.fail(new Error(`Vehicle '${name}' not found`))
                    : Effect.succeed(vehicle),
                ),
                retryObservation,
              );
            }
          }

          // 3c. Sync tags against OBSERVED cloud tags.
          const arn = observed.arn;
          if (arn !== undefined) {
            yield* syncFleetWiseTags(arn, desiredTags);
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent: deleting a missing vehicle succeeds. The backing
          // IoT thing (if auto-created) is left in place, matching AWS
          // behavior.
          yield* iotfleetwise
            .deleteVehicle({ vehicleName: output.vehicleName })
            .pipe(inFleetWiseRegion);
        }),

        list: () =>
          iotfleetwise.listVehicles.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).map((summary) => ({
                vehicleName: summary.vehicleName,
                vehicleArn: summary.arn,
                modelManifestArn: summary.modelManifestArn,
                decoderManifestArn: summary.decoderManifestArn,
                attributes: toAttributeRecord(summary.attributes),
              })),
            ),
            inFleetWiseRegion,
          ),
      };
    }),
  );
