import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readIotWirelessTags,
  sameShape,
  syncIotWirelessTags,
} from "./internal.ts";

export interface ServiceProfileProps {
  /**
   * Name of the service profile. If omitted, a deterministic physical name
   * is generated from the app, stage, and logical ID. Service profiles are
   * immutable — changing the name replaces the profile.
   */
  name?: string;
  /**
   * LoRaWAN service profile configuration (data-rate bounds, gateway
   * metadata, roaming flags, transmission counts). Immutable — changing any
   * field replaces the profile.
   */
  loRaWAN?: iotw.LoRaWANServiceProfile;
  /**
   * Tags applied to the service profile. Alchemy ownership tags are merged
   * in automatically.
   */
  tags?: Record<string, string>;
}

export interface ServiceProfile extends Resource<
  "AWS.IoTWireless.ServiceProfile",
  ServiceProfileProps,
  {
    /** Server-assigned ID of the service profile. */
    serviceProfileId: string;
    /** ARN of the service profile. */
    serviceProfileArn: string;
    /** Name of the service profile. */
    serviceProfileName: string;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Core for LoRaWAN service profile — the network-level parameters
 * (data-rate bounds, gateway metadata reporting, roaming permissions) shared
 * by a fleet of wireless devices.
 *
 * Service profiles are immutable after creation: any change to `name` or
 * `loRaWAN` replaces the profile. Only tags update in place.
 * @resource
 * @section Creating Service Profiles
 * @example Default Service Profile
 * ```typescript
 * import * as IoTWireless from "alchemy/AWS/IoTWireless";
 *
 * const profile = yield* IoTWireless.ServiceProfile("Fleet");
 * ```
 *
 * @example Service Profile with Gateway Metadata
 * ```typescript
 * const profile = yield* IoTWireless.ServiceProfile("Fleet", {
 *   loRaWAN: { AddGwMetadata: true, DrMin: 0, DrMax: 10 },
 *   tags: { team: "iot" },
 * });
 * ```
 *
 * @section Referencing from Devices
 * @example Wire a device to the profile
 * ```typescript
 * const device = yield* IoTWireless.WirelessDevice("Sensor", {
 *   type: "LoRaWAN",
 *   destinationName: destination.destinationName,
 *   loRaWAN: {
 *     DevEui: "1122334455667788",
 *     ServiceProfileId: profile.serviceProfileId,
 *     DeviceProfileId: deviceProfile.deviceProfileId,
 *     OtaaV1_0_x: { AppKey: "...", AppEui: "..." },
 *   },
 * });
 * ```
 */
export const ServiceProfile = Resource<ServiceProfile>(
  "AWS.IoTWireless.ServiceProfile",
);

export const ServiceProfileProvider = () =>
  Provider.effect(
    ServiceProfile,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const getById = (serviceProfileId: string) =>
        iotw
          .getServiceProfile({ Id: serviceProfileId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // Service profiles have no name-keyed Get — enumerate and match. The
      // physical name is deterministic, so this recovers identity after a
      // lost state write.
      const findByName = (name: string) =>
        iotw.listServiceProfiles.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.ServiceProfileList ?? [])
              .find((p) => p.Name === name),
          ),
        );

      const observe = Effect.fn(function* (
        output: ServiceProfile["Attributes"] | undefined,
        name: string,
      ) {
        if (output?.serviceProfileId !== undefined) {
          const found = yield* getById(output.serviceProfileId);
          if (found !== undefined) return found;
        }
        const summary = yield* findByName(name);
        if (summary?.Id === undefined) return undefined;
        return yield* getById(summary.Id);
      });

      const toAttrs = Effect.fn(function* (
        profile: iotw.GetServiceProfileResponse,
        name: string,
      ) {
        if (profile.Id === undefined || profile.Arn === undefined) {
          return yield* Effect.fail(
            new Error(
              `IoT Wireless service profile '${name}' returned without Id/Arn`,
            ),
          );
        }
        return {
          serviceProfileId: profile.Id,
          serviceProfileArn: profile.Arn,
          serviceProfileName: profile.Name ?? name,
        };
      });

      return ServiceProfile.Provider.of({
        stables: [
          "serviceProfileId",
          "serviceProfileArn",
          "serviceProfileName",
        ],

        list: () =>
          iotw.listServiceProfiles.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.ServiceProfileList ?? [])
                .flatMap((p) =>
                  p.Id !== undefined && p.Arn !== undefined
                    ? [
                        {
                          serviceProfileId: p.Id,
                          serviceProfileArn: p.Arn,
                          serviceProfileName: p.Name ?? p.Id,
                        },
                      ]
                    : [],
                ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.serviceProfileName ?? (yield* createName(id, olds ?? {}));
          const profile = yield* observe(output, name);
          if (profile === undefined) return undefined;
          const attrs = yield* toAttrs(profile, name);
          const tags = yield* readIotWirelessTags(attrs.serviceProfileArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // There is no UpdateServiceProfile API — name and LoRaWAN config are
        // create-only, so any change to either replaces the profile. Tags
        // stay update-in-place.
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if (!sameShape(olds?.loRaWAN, news.loRaWAN)) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.serviceProfileName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output is an id cache.
          let profile = yield* observe(output, name);

          // 2. ENSURE — create if missing. CreateServiceProfile always mints
          //    a new profile (names are not unique keys), so re-observing by
          //    name after a Conflict race keeps this idempotent.
          if (profile === undefined) {
            yield* session.note(`creating service profile ${name}`);
            const created = yield* iotw
              .createServiceProfile({
                Name: name,
                LoRaWAN: news.loRaWAN,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            profile =
              created?.Id !== undefined
                ? yield* getById(created.Id)
                : yield* observe(undefined, name);
          }
          if (profile === undefined) {
            return yield* Effect.fail(
              new Error(
                `IoT Wireless service profile '${name}' not found after create`,
              ),
            );
          }

          // 3. SYNC — only tags are mutable; diff against OBSERVED tags.
          const attrs = yield* toAttrs(profile, name);
          yield* syncIotWirelessTags(attrs.serviceProfileArn, desiredTags);

          yield* session.note(attrs.serviceProfileId);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* iotw
            .deleteServiceProfile({ Id: output.serviceProfileId })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
