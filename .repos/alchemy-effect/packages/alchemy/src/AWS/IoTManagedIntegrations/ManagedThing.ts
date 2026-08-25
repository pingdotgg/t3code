import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  syncManagedIntegrationsTags,
  toTagRecord,
  unwrapSensitive,
} from "./internal.ts";

export interface ManagedThingProps {
  /**
   * Role of the device in Managed integrations: a `CONTROLLER` onboards and
   * controls devices; a `DEVICE` is an endpoint. Changing the role replaces
   * the managed thing.
   */
  role: mi.Role;
  /**
   * Authentication material used to onboard the device (e.g. the payload of
   * a Wi-Fi setup or Zigbee QR bar code). This is a device-onboarding
   * credential — wrap it with `Redacted.make(...)`. Create-only — changing
   * it replaces the managed thing.
   */
  authenticationMaterial: Redacted.Redacted<string>;
  /**
   * Type of the authentication material.
   * E.g. `WIFI_SETUP_QR_BAR_CODE`, `ZIGBEE_QR_BAR_CODE`, `ZWAVE_QR_BAR_CODE`.
   * Create-only — changing it replaces the managed thing.
   */
  authenticationMaterialType: mi.AuthMaterialType;
  /**
   * Display name of the managed thing. If omitted, a unique name is generated
   * from the app, stage, and logical ID.
   */
  name?: string;
  /**
   * Identifier of the credential locker used by the managed thing.
   */
  credentialLockerId?: string;
  /**
   * Owner of the managed thing.
   */
  owner?: string;
  /**
   * Serial number of the device.
   */
  serialNumber?: string;
  /**
   * Brand of the device.
   */
  brand?: string;
  /**
   * Model of the device.
   */
  model?: string;
  /**
   * Classification of the managed thing.
   */
  classification?: string;
  /**
   * Capability report of the device.
   */
  capabilityReport?: mi.CapabilityReport;
  /**
   * Metadata key-value pairs for the managed thing.
   */
  metaData?: Record<string, string>;
  /**
   * User-defined tags to apply to the managed thing.
   */
  tags?: Record<string, string>;
}

export interface ManagedThing extends Resource<
  "AWS.IoTManagedIntegrations.ManagedThing",
  ManagedThingProps,
  {
    /** Service-generated identifier of the managed thing. */
    managedThingId: string;
    /** ARN of the managed thing. */
    managedThingArn: string;
    /** Display name of the managed thing. */
    managedThingName: string;
    /** Role of the device (CONTROLLER or DEVICE). */
    role: mi.Role;
    /** Provisioning status of the managed thing. */
    provisioningStatus: mi.ProvisioningStatus | undefined;
    /** Tags applied to the managed thing (user + internal). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Managed Integrations managed thing — the cloud representation of
 * a device (or controller) onboarded through Managed integrations, carrying
 * its identity, protocol, and capability data model.
 *
 * Creating a managed thing requires real device onboarding material (e.g. a
 * Wi-Fi Simple Setup or Zigbee QR bar code payload). IoT Managed Integrations
 * is a regional service available in a limited set of regions (e.g.
 * `eu-west-1`, `ca-central-1`).
 *
 * @resource
 * @section Creating Managed Things
 * @example Controller from a Wi-Fi Setup QR Code
 * ```typescript
 * const thing = yield* ManagedThing("Hub", {
 *   role: "CONTROLLER",
 *   authenticationMaterial: Redacted.make(wifiSetupQrCodePayload),
 *   authenticationMaterialType: "WIFI_SETUP_QR_BAR_CODE",
 * });
 * ```
 *
 * @example Device with a Credential Locker
 * ```typescript
 * const locker = yield* CredentialLocker("DeviceCredentials", {});
 * const thing = yield* ManagedThing("Sensor", {
 *   role: "DEVICE",
 *   authenticationMaterial: Redacted.make(zigbeeQrCodePayload),
 *   authenticationMaterialType: "ZIGBEE_QR_BAR_CODE",
 *   credentialLockerId: locker.credentialLockerId,
 *   serialNumber: "SN-0001",
 * });
 * ```
 */
export const ManagedThing = Resource<ManagedThing>(
  "AWS.IoTManagedIntegrations.ManagedThing",
);

export const ManagedThingProvider = () =>
  Provider.effect(
    ManagedThing,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      const observeById = (identifier: string) =>
        mi
          .getManagedThing({ Identifier: identifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // Recover an existing managed thing by display name when no Id is
      // cached (e.g. after a state persistence failure).
      const findByName = Effect.fn(function* (name: string) {
        const summary = yield* mi.listManagedThings.items({}).pipe(
          Stream.filter((item) => item.Name === name),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]),
        );
        if (summary?.Id === undefined) return undefined;
        return yield* observeById(summary.Id);
      });

      const toAttributes = Effect.fn(function* (
        thing: mi.GetManagedThingResponse,
      ) {
        if (
          thing.Id === undefined ||
          thing.Arn === undefined ||
          thing.Name === undefined ||
          thing.Role === undefined
        ) {
          return yield* Effect.fail(
            new Error(
              "managed thing response is missing Id, Arn, Name, or Role",
            ),
          );
        }
        return {
          managedThingId: thing.Id,
          managedThingArn: thing.Arn,
          managedThingName: thing.Name,
          role: thing.Role,
          provisioningStatus: thing.ProvisioningStatus,
          tags: toTagRecord(thing.Tags),
        };
      });

      return {
        stables: ["managedThingId", "managedThingArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // Role and authentication material are create-only.
          if (
            olds.role !== news.role ||
            Redacted.value(olds.authenticationMaterial) !==
              Redacted.value(news.authenticationMaterial) ||
            olds.authenticationMaterialType !== news.authenticationMaterialType
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const thing =
            output?.managedThingId !== undefined
              ? yield* observeById(output.managedThingId)
              : yield* findByName(yield* toName(id, olds ?? {}));
          if (thing === undefined) return undefined;
          const attrs = yield* toAttributes(thing);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — cloud state is authoritative; output is only an Id cache.
          let thing =
            output?.managedThingId !== undefined
              ? yield* observeById(output.managedThingId)
              : yield* findByName(name);

          // Ensure — create if missing.
          if (thing === undefined) {
            const created = yield* mi.createManagedThing({
              Role: news.role,
              AuthenticationMaterial: news.authenticationMaterial,
              AuthenticationMaterialType: news.authenticationMaterialType,
              Name: name,
              CredentialLockerId: news.credentialLockerId,
              Owner: news.owner,
              SerialNumber: news.serialNumber,
              Brand: news.brand,
              Model: news.model,
              Classification: news.classification,
              CapabilityReport: news.capabilityReport,
              MetaData: news.metaData,
              Tags: desiredTags,
            });
            if (created.Id === undefined) {
              return yield* Effect.fail(
                new Error(`failed to create managed thing '${name}'`),
              );
            }
            thing = yield* observeById(created.Id);
            if (thing === undefined) {
              return yield* Effect.fail(
                new Error(
                  `managed thing '${created.Id}' vanished after create`,
                ),
              );
            }
          } else if (thing.Id !== undefined) {
            // Sync mutable, observable fields — apply only the delta.
            const observed = {
              name: thing.Name,
              credentialLockerId: thing.CredentialLockerId,
              owner: unwrapSensitive(thing.Owner),
              serialNumber: unwrapSensitive(thing.SerialNumber),
              brand: unwrapSensitive(thing.Brand),
              model: unwrapSensitive(thing.Model),
              classification: unwrapSensitive(thing.Classification),
            };
            const desired = {
              name,
              credentialLockerId: news.credentialLockerId,
              owner: news.owner,
              serialNumber: news.serialNumber,
              brand: news.brand,
              model: news.model,
              classification: news.classification,
            };
            const changed = (
              Object.keys(desired) as (keyof typeof desired)[]
            ).filter(
              (key) =>
                desired[key] !== undefined && desired[key] !== observed[key],
            );
            if (changed.length > 0) {
              yield* mi.updateManagedThing({
                Identifier: thing.Id,
                Name: name,
                CredentialLockerId: news.credentialLockerId,
                Owner: news.owner,
                SerialNumber: news.serialNumber,
                Brand: news.brand,
                Model: news.model,
                Classification: news.classification,
                MetaData: news.metaData,
              });
              thing = yield* observeById(thing.Id);
              if (thing === undefined) {
                return yield* Effect.fail(
                  new Error(`managed thing '${name}' vanished during update`),
                );
              }
            }
          }

          // Sync tags — diff against OBSERVED cloud tags.
          if (thing.Arn !== undefined) {
            yield* syncManagedIntegrationsTags(
              thing.Arn,
              toTagRecord(thing.Tags),
              desiredTags,
            );
          }

          const attrs = yield* toAttributes(thing);
          yield* session.note(attrs.managedThingArn);
          return { ...attrs, tags: desiredTags };
        }),
        // Enumerate every managed thing in the account/region; fetch each one
        // to resolve tags (summaries omit them).
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* mi.listManagedThings.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const things = yield* Effect.forEach(
              summaries.filter(
                (s): s is mi.ManagedThingSummary & { Id: string } =>
                  s.Id !== undefined,
              ),
              (summary) => observeById(summary.Id),
              { concurrency: 5 },
            );
            return yield* Effect.forEach(
              things.filter(
                (thing): thing is mi.GetManagedThingResponse =>
                  thing !== undefined,
              ),
              toAttributes,
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* mi
            .deleteManagedThing({ Identifier: output.managedThingId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
