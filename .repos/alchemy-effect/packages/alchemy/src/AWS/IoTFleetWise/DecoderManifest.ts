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

export interface DecoderManifestProps {
  /**
   * Name of the decoder manifest. Must be 1-100 characters of
   * `[a-zA-Z0-9:_-]`. If omitted, a deterministic physical name is
   * generated. Changing the name replaces the manifest.
   */
  decoderManifestName?: string;
  /**
   * ARN of the {@link ModelManifest} the decoder manifest decodes signals
   * for. Changing the model manifest replaces the decoder manifest.
   */
  modelManifestArn: string;
  /**
   * Human-readable description of the decoder manifest.
   */
  description?: string;
  /**
   * Network interfaces (CAN, OBD, vehicle middleware or custom decoding)
   * the signal decoders reference, keyed by `interfaceId`. Updated in
   * place via add/update/remove deltas (only while the manifest is in
   * `DRAFT` status).
   */
  networkInterfaces?: iotfleetwise.NetworkInterface[];
  /**
   * Decoding rules mapping model-manifest signals onto network-interface
   * messages, keyed by `fullyQualifiedName`. Updated in place via
   * add/update/remove deltas (only while the manifest is in `DRAFT`
   * status).
   */
  signalDecoders?: iotfleetwise.SignalDecoder[];
  /**
   * Use `"CUSTOM_DECODING"` to default any unmapped model-manifest signal
   * to a custom decoding signal.
   */
  defaultForUnmappedSignals?: iotfleetwise.DefaultForUnmappedSignalsType;
  /**
   * Status of the manifest. Vehicles can only be created from an `ACTIVE`
   * manifest; decoder/interface changes require `DRAFT`.
   * @default "DRAFT"
   */
  status?: "ACTIVE" | "DRAFT";
  /**
   * User-defined tags for the decoder manifest.
   */
  tags?: Record<string, string>;
}

export interface DecoderManifest extends Resource<
  "AWS.IoTFleetWise.DecoderManifest",
  DecoderManifestProps,
  {
    /** The name of the decoder manifest. */
    decoderManifestName: string;
    /** The ARN of the decoder manifest. */
    decoderManifestArn: string;
    /** The current status of the manifest (`ACTIVE`, `DRAFT`, ...). */
    status: string;
    /** The model manifest the decoders map to. */
    modelManifestArn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT FleetWise decoder manifest — the decoding rules (network
 * interfaces + signal decoders) that turn raw bus data from a vehicle
 * modeled by a {@link ModelManifest} into standardized signals.
 *
 * A manifest is created in `DRAFT` status; set `status: "ACTIVE"` to make
 * it usable by vehicles. AWS IoT FleetWise is allowlist-gated and offered
 * in `us-east-1`/`eu-central-1` only.
 * @resource
 * @section Creating a Decoder Manifest
 * @example OBD Decoder for a Speed Signal
 * ```typescript
 * const decoder = yield* DecoderManifest("SedanDecoder", {
 *   modelManifestArn: model.modelManifestArn,
 *   networkInterfaces: [
 *     {
 *       interfaceId: "obd0",
 *       type: "OBD_INTERFACE",
 *       obdInterface: { name: "obd", requestMessageId: 2015 },
 *     },
 *   ],
 *   signalDecoders: [
 *     {
 *       fullyQualifiedName: "Vehicle.Speed",
 *       type: "OBD_SIGNAL",
 *       interfaceId: "obd0",
 *       obdSignal: {
 *         pidResponseLength: 1,
 *         serviceMode: 1,
 *         pid: 13,
 *         scaling: 1,
 *         offset: 0,
 *         startByte: 0,
 *         byteLength: 1,
 *       },
 *     },
 *   ],
 *   status: "ACTIVE",
 * });
 * ```
 */
export const DecoderManifest = Resource<DecoderManifest>(
  "AWS.IoTFleetWise.DecoderManifest",
);

export const DecoderManifestProvider = () =>
  Provider.effect(
    DecoderManifest,
    Effect.gen(function* () {
      const toName = (id: string, props: { decoderManifestName?: string }) =>
        props.decoderManifestName
          ? Effect.succeed(props.decoderManifestName)
          : createPhysicalName({ id, maxLength: 100 });

      const readManifest = Effect.fn(function* (name: string) {
        return yield* iotfleetwise.getDecoderManifest({ name }).pipe(
          inFleetWiseRegion,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const observeAfterWrite = Effect.fn(function* (name: string) {
        return yield* readManifest(name).pipe(
          Effect.flatMap((manifest) =>
            manifest === undefined
              ? Effect.fail(new Error(`Decoder manifest '${name}' not found`))
              : Effect.succeed(manifest),
          ),
          retryObservation,
        );
      });

      const readInterfaces = Effect.fn(function* (name: string) {
        return yield* iotfleetwise.listDecoderManifestNetworkInterfaces
          .items({ name })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            inFleetWiseRegion,
          );
      });

      const readDecoders = Effect.fn(function* (name: string) {
        return yield* iotfleetwise.listDecoderManifestSignals
          .items({ name })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            inFleetWiseRegion,
          );
      });

      const toAttrs = (manifest: iotfleetwise.GetDecoderManifestResponse) => ({
        decoderManifestName: manifest.name,
        decoderManifestArn: manifest.arn,
        status: manifest.status ?? "DRAFT",
        modelManifestArn: manifest.modelManifestArn,
      });

      return {
        stables: ["decoderManifestName", "decoderManifestArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
          // The update API cannot change the model manifest.
          if (news.modelManifestArn !== olds.modelManifestArn) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.decoderManifestName ?? (yield* toName(id, olds ?? {}));
          const found = yield* readManifest(name);
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readFleetWiseTags(found.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.decoderManifestName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredStatus = news.status ?? "DRAFT";
          const desiredInterfaces = news.networkInterfaces ?? [];
          const desiredDecoders = news.signalDecoders ?? [];

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readManifest(name);

          // 2. Ensure — create if missing; tolerate the AlreadyExists race.
          if (observed === undefined) {
            yield* iotfleetwise
              .createDecoderManifest({
                name,
                modelManifestArn: news.modelManifestArn,
                description: news.description,
                networkInterfaces:
                  desiredInterfaces.length > 0 ? desiredInterfaces : undefined,
                signalDecoders:
                  desiredDecoders.length > 0 ? desiredDecoders : undefined,
                defaultForUnmappedSignals: news.defaultForUnmappedSignals,
                tags: toFleetWiseTagList(desiredTags),
              })
              .pipe(
                inFleetWiseRegion,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            observed = yield* observeAfterWrite(name);
          }

          // 3. Sync interfaces + decoders + description — diff OBSERVED
          //    lists against desired, keyed by interfaceId /
          //    fullyQualifiedName. Structural changes require DRAFT status,
          //    so they run before any DRAFT -> ACTIVE transition.
          const observedInterfaces = yield* readInterfaces(name);
          const observedDecoders = yield* readDecoders(name);
          const observedInterfaceById = new Map(
            observedInterfaces.map((i) => [i.interfaceId, i]),
          );
          const desiredInterfaceById = new Map(
            desiredInterfaces.map((i) => [i.interfaceId, i]),
          );
          const observedDecoderByFqn = new Map(
            observedDecoders.map((d) => [d.fullyQualifiedName, d]),
          );
          const desiredDecoderByFqn = new Map(
            desiredDecoders.map((d) => [d.fullyQualifiedName, d]),
          );

          const interfacesToAdd = desiredInterfaces.filter(
            (i) => !observedInterfaceById.has(i.interfaceId),
          );
          const interfacesToUpdate = desiredInterfaces.filter((i) => {
            const current = observedInterfaceById.get(i.interfaceId);
            return current !== undefined && !stableEquals(current, i);
          });
          const interfacesToRemove = observedInterfaces
            .map((i) => i.interfaceId)
            .filter((id_) => !desiredInterfaceById.has(id_));
          const decodersToAdd = desiredDecoders.filter(
            (d) => !observedDecoderByFqn.has(d.fullyQualifiedName),
          );
          const decodersToUpdate = desiredDecoders.filter((d) => {
            const current = observedDecoderByFqn.get(d.fullyQualifiedName);
            return current !== undefined && !stableEquals(current, d);
          });
          const decodersToRemove = observedDecoders
            .map((d) => d.fullyQualifiedName)
            .filter((fqn) => !desiredDecoderByFqn.has(fqn));
          const descriptionChanged =
            news.description !== undefined &&
            news.description !== observed.description;

          if (
            interfacesToAdd.length > 0 ||
            interfacesToUpdate.length > 0 ||
            interfacesToRemove.length > 0 ||
            decodersToAdd.length > 0 ||
            decodersToUpdate.length > 0 ||
            decodersToRemove.length > 0 ||
            descriptionChanged
          ) {
            yield* iotfleetwise
              .updateDecoderManifest({
                name,
                description: descriptionChanged ? news.description : undefined,
                networkInterfacesToAdd:
                  interfacesToAdd.length > 0 ? interfacesToAdd : undefined,
                networkInterfacesToUpdate:
                  interfacesToUpdate.length > 0
                    ? interfacesToUpdate
                    : undefined,
                networkInterfacesToRemove:
                  interfacesToRemove.length > 0
                    ? interfacesToRemove
                    : undefined,
                signalDecodersToAdd:
                  decodersToAdd.length > 0 ? decodersToAdd : undefined,
                signalDecodersToUpdate:
                  decodersToUpdate.length > 0 ? decodersToUpdate : undefined,
                signalDecodersToRemove:
                  decodersToRemove.length > 0 ? decodersToRemove : undefined,
                defaultForUnmappedSignals: news.defaultForUnmappedSignals,
              })
              .pipe(inFleetWiseRegion);
            observed = yield* observeAfterWrite(name);
          }

          // 3b. Sync status (e.g. activate a draft).
          if ((observed.status ?? "DRAFT") !== desiredStatus) {
            yield* iotfleetwise
              .updateDecoderManifest({ name, status: desiredStatus })
              .pipe(inFleetWiseRegion);
            observed = yield* observeAfterWrite(name);
          }

          // 3c. Sync tags against OBSERVED cloud tags.
          yield* syncFleetWiseTags(observed.arn, desiredTags);

          yield* session.note(name);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent: deleting a missing manifest succeeds. Vehicles
          // still detaching surface as ConflictException — retry through
          // the window (bounded).
          yield* iotfleetwise
            .deleteDecoderManifest({ name: output.decoderManifestName })
            .pipe(
              inFleetWiseRegion,
              retryWhileConflict,
              Effect.catchTag("ConflictException", () => Effect.void),
            );
        }),

        list: () =>
          iotfleetwise.listDecoderManifests.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((summary) =>
                summary.name !== undefined && summary.arn !== undefined
                  ? [
                      {
                        decoderManifestName: summary.name,
                        decoderManifestArn: summary.arn,
                        status: summary.status ?? "DRAFT",
                        modelManifestArn: summary.modelManifestArn,
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
