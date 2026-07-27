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

export interface DeviceProfileProps {
  /**
   * Name of the device profile. If omitted, a deterministic physical name
   * is generated from the app, stage, and logical ID. Device profiles are
   * immutable — changing the name replaces the profile.
   */
  name?: string;
  /**
   * LoRaWAN device profile configuration (MAC version, regional parameters,
   * RX windows, class B/C support). Immutable — changing any field replaces
   * the profile.
   */
  loRaWAN?: iotw.LoRaWANDeviceProfile;
  /**
   * Sidewalk device profile configuration. Set to `{}` to create an Amazon
   * Sidewalk device profile instead of a LoRaWAN one. Immutable.
   */
  sidewalk?: iotw.SidewalkCreateDeviceProfile;
  /**
   * Tags applied to the device profile. Alchemy ownership tags are merged
   * in automatically.
   */
  tags?: Record<string, string>;
}

export interface DeviceProfile extends Resource<
  "AWS.IoTWireless.DeviceProfile",
  DeviceProfileProps,
  {
    /** Server-assigned ID of the device profile. */
    deviceProfileId: string;
    /** ARN of the device profile. */
    deviceProfileArn: string;
    /** Name of the device profile. */
    deviceProfileName: string;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Core for LoRaWAN device profile — the hardware-level LoRaWAN
 * parameters (MAC version, regional band, RX windows, device classes) shared
 * by devices of the same model.
 *
 * Device profiles are immutable after creation: any change to `name`,
 * `loRaWAN`, or `sidewalk` replaces the profile. Only tags update in place.
 * @resource
 * @section Creating Device Profiles
 * @example US915 OTAA Device Profile
 * ```typescript
 * import * as IoTWireless from "alchemy/AWS/IoTWireless";
 *
 * const profile = yield* IoTWireless.DeviceProfile("SensorModel", {
 *   loRaWAN: {
 *     MacVersion: "1.0.3",
 *     RegParamsRevision: "RP002-1.0.1",
 *     RfRegion: "US915",
 *     MaxEirp: 10,
 *     SupportsJoin: true,
 *   },
 * });
 * ```
 *
 * @example Sidewalk Device Profile
 * ```typescript
 * const profile = yield* IoTWireless.DeviceProfile("SidewalkModel", {
 *   sidewalk: {},
 * });
 * ```
 */
export const DeviceProfile = Resource<DeviceProfile>(
  "AWS.IoTWireless.DeviceProfile",
);

export const DeviceProfileProvider = () =>
  Provider.effect(
    DeviceProfile,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const getById = (deviceProfileId: string) =>
        iotw
          .getDeviceProfile({ Id: deviceProfileId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // Device profiles have no name-keyed Get — enumerate and match. The
      // physical name is deterministic, so this recovers identity after a
      // lost state write.
      const findByName = (name: string) =>
        iotw.listDeviceProfiles.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.DeviceProfileList ?? [])
              .find((p) => p.Name === name),
          ),
        );

      const observe = Effect.fn(function* (
        output: DeviceProfile["Attributes"] | undefined,
        name: string,
      ) {
        if (output?.deviceProfileId !== undefined) {
          const found = yield* getById(output.deviceProfileId);
          if (found !== undefined) return found;
        }
        const summary = yield* findByName(name);
        if (summary?.Id === undefined) return undefined;
        return yield* getById(summary.Id);
      });

      const toAttrs = Effect.fn(function* (
        profile: iotw.GetDeviceProfileResponse,
        name: string,
      ) {
        if (profile.Id === undefined || profile.Arn === undefined) {
          return yield* Effect.fail(
            new Error(
              `IoT Wireless device profile '${name}' returned without Id/Arn`,
            ),
          );
        }
        return {
          deviceProfileId: profile.Id,
          deviceProfileArn: profile.Arn,
          deviceProfileName: profile.Name ?? name,
        };
      });

      return DeviceProfile.Provider.of({
        stables: ["deviceProfileId", "deviceProfileArn", "deviceProfileName"],

        list: () =>
          iotw.listDeviceProfiles.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.DeviceProfileList ?? [])
                .flatMap((p) =>
                  p.Id !== undefined && p.Arn !== undefined
                    ? [
                        {
                          deviceProfileId: p.Id,
                          deviceProfileArn: p.Arn,
                          deviceProfileName: p.Name ?? p.Id,
                        },
                      ]
                    : [],
                ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.deviceProfileName ?? (yield* createName(id, olds ?? {}));
          const profile = yield* observe(output, name);
          if (profile === undefined) return undefined;
          const attrs = yield* toAttrs(profile, name);
          const tags = yield* readIotWirelessTags(attrs.deviceProfileArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // There is no UpdateDeviceProfile API — name and radio config are
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
          if (
            (olds?.sidewalk === undefined) !==
            (news.sidewalk === undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.deviceProfileName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output is an id cache.
          let profile = yield* observe(output, name);

          // 2. ENSURE — create if missing. CreateDeviceProfile always mints
          //    a new profile (names are not unique keys), so re-observing by
          //    name after a Conflict race keeps this idempotent.
          if (profile === undefined) {
            yield* session.note(`creating device profile ${name}`);
            const created = yield* iotw
              .createDeviceProfile({
                Name: name,
                LoRaWAN: news.loRaWAN,
                Sidewalk: news.sidewalk,
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
                `IoT Wireless device profile '${name}' not found after create`,
              ),
            );
          }

          // 3. SYNC — only tags are mutable; diff against OBSERVED tags.
          const attrs = yield* toAttrs(profile, name);
          yield* syncIotWirelessTags(attrs.deviceProfileArn, desiredTags);

          yield* session.note(attrs.deviceProfileId);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* iotw.deleteDeviceProfile({ Id: output.deviceProfileId }).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
