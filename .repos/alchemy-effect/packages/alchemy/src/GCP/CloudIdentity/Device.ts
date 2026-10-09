import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  findOwnedDevice,
  getDevice,
  hasOwnershipMarker,
  lastSegment,
  listDevices,
  MAX_ASSET_TAG_LENGTH,
  normalizeCustomer,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  replaceOnIdentity,
  toPhysicalId,
} from "./internal.ts";
import {
  resourceNameFromOperation,
  waitForOperation,
  waitUntilPresent,
} from "./operations.ts";

export type DeviceProps = {
  /**
   * Customer that owns the device (`customers/my_customer` or
   * `customers/{customer}`). Immutable — changing it replaces the
   * device.
   * @default "customers/my_customer"
   */
  customer?: string;
  /**
   * Serial number. If omitted, a unique value is generated. Immutable
   * — changing it replaces the device. Only company-owned devices can
   * be created.
   */
  serialNumber?: string;
  /**
   * Device type. Immutable — changing it replaces the device.
   * @default "LINUX"
   */
  deviceType?:
    | cloudidentity.GoogleAppsCloudidentityDevicesV1DeviceDeviceTypeEnum
    | (string & {});
  /**
   * Asset tag. Devices have no labels field, so Alchemy stores
   * ownership in a `[alchemy …]` prefix and strips it from attributes.
   */
  assetTag?: string;
  /**
   * Host name.
   */
  hostname?: string;
  /**
   * WiFi MAC addresses.
   */
  wifiMacAddresses?: string[];
  /**
   * Partner-specified unique device identifier.
   */
  deviceId?: string;
};

export type Device = Resource<
  "GCP.CloudIdentity.Device",
  DeviceProps,
  {
    /** Resource name `devices/{device}`. */
    name: string;
    /** Device id (last path segment). */
    deviceResourceId: string;
    /** Customer used on create. */
    customer: string;
    /** Serial number. */
    serialNumber: string | undefined;
    /** Device type. */
    deviceType: string | undefined;
    /** Asset tag with the Alchemy ownership prefix stripped. */
    assetTag: string | undefined;
    /** Host name. */
    hostname: string | undefined;
    /** WiFi MAC addresses. */
    wifiMacAddresses: string[] | undefined;
    /** Partner device id. */
    deviceId: string | undefined;
    /** Owner type (`COMPANY` or `BYOD`). */
    ownerType: string | undefined;
    /** Management state. */
    managementState: string | undefined;
    /** Compromised state. */
    compromisedState: string | undefined;
    /** Encryption state. */
    encryptionState: string | undefined;
    /** RFC3339 import timestamp. */
    createTime: string | undefined;
    /** Last sync time. */
    lastSyncTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Identity company-owned device.
 *
 * Device create is limited to company-owned inventory (Enterprise /
 * Cloud Identity Premium). There is no update API — serial number,
 * type, and customer are identity. Alchemy stamps ownership into
 * `assetTag` for `list` / nuke.
 *
 * ### Creating a Device
 * **Example:** Generated serial
 * ```typescript
 * const device = yield* GCP.CloudIdentity.Device("Laptop", {
 *   deviceType: "LINUX",
 *   hostname: "eng-laptop",
 * });
 * ```
 *
 * **Example:** Explicit serial and asset tag
 * ```typescript
 * const device = yield* GCP.CloudIdentity.Device("Laptop", {
 *   serialNumber: "HT82V1A01076",
 *   deviceType: "LINUX",
 *   assetTag: "desk-14",
 * });
 * ```
 *
 * @resource
 * @category CloudIdentity
 */
export const Device = Resource<Device>("GCP.CloudIdentity.Device");

export class DeviceNotResolved extends Data.TaggedError(
  "GCP.CloudIdentity.DeviceNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_DEVICE_TYPE = "LINUX";

const toAttrs = (
  device: cloudidentity.GoogleAppsCloudidentityDevicesV1Device,
  customer: string,
) => {
  const name = device.name ?? "";
  return {
    name,
    deviceResourceId: lastSegment(name),
    customer,
    serialNumber: device.serialNumber,
    deviceType: device.deviceType,
    assetTag: parseOwnership(device.assetTag).text,
    hostname: device.hostname,
    wifiMacAddresses: device.wifiMacAddresses,
    deviceId: device.deviceId,
    ownerType: device.ownerType,
    managementState: device.managementState,
    compromisedState: device.compromisedState,
    encryptionState: device.encryptionState,
    createTime: device.createTime,
    lastSyncTime: device.lastSyncTime,
  };
};

const observeDevice = (input: {
  id: string;
  name?: string;
  serialNumber?: string;
  customer: string;
}) =>
  Effect.gen(function* () {
    const byName = yield* getDevice(input.name ?? "", input.customer);
    if (byName !== undefined) return byName;
    return yield* findOwnedDevice(input.id, input.serialNumber, input.customer);
  });

export const DeviceProvider = () =>
  Provider.succeed(Device, {
    stables: [
      "name",
      "deviceResourceId",
      "customer",
      "serialNumber",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCustomer = olds?.customer ?? output?.customer;
      const nextCustomer =
        news.customer !== undefined
          ? normalizeCustomer(news.customer)
          : previousCustomer;
      const previousType = olds?.deviceType ?? output?.deviceType;
      const nextType = news.deviceType ?? DEFAULT_DEVICE_TYPE;
      return replaceOnIdentity({
        previousId: olds?.serialNumber ?? output?.serialNumber,
        nextId: news.serialNumber,
        previousParent: previousCustomer,
        nextParent: nextCustomer,
        extra: previousType !== undefined && previousType !== nextType,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const customer = normalizeCustomer(olds?.customer ?? output?.customer);
      const existing = yield* observeDevice({
        id,
        name: output?.name,
        serialNumber: olds?.serialNumber ?? output?.serialNumber,
        customer,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, customer);
      return (yield* ownedByAlchemy(id, existing.assetTag))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const devices = yield* listDevices();
        return devices
          .filter((device) => hasOwnershipMarker(device.assetTag))
          .map((device) => toAttrs(device, DEFAULT_CUSTOMER_FALLBACK));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const customer = normalizeCustomer(news.customer ?? output?.customer);
      const ownership = yield* ownershipLabels(id);
      const serialNumber = yield* toPhysicalId(
        id,
        news.serialNumber,
        output?.serialNumber,
        20,
      );
      const assetTag = encodeOwnershipLine(
        ownership,
        news.assetTag,
        MAX_ASSET_TAG_LENGTH,
      );
      const deviceType = news.deviceType ?? DEFAULT_DEVICE_TYPE;
      const desired: cloudidentity.GoogleAppsCloudidentityDevicesV1Device = {
        serialNumber,
        deviceType,
        assetTag,
        hostname: news.hostname,
        wifiMacAddresses: news.wifiMacAddresses,
        deviceId: news.deviceId,
      };

      let current = yield* observeDevice({
        id,
        name: output?.name,
        serialNumber,
        customer,
      });

      if (current === undefined) {
        const created = yield* cloudidentity
          .createDevices({
            customer,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<cloudidentity.Operation | undefined>(undefined),
            ),
          );
        if (created !== undefined) {
          yield* waitForOperation(created).pipe(
            Effect.catchTag(
              "GCP.CloudIdentity.OperationPending",
              () => Effect.void,
            ),
          );
          const createdName = resourceNameFromOperation(created);
          if (createdName !== undefined) {
            current = yield* getDevice(createdName, customer);
          }
        }
        if (current === undefined) {
          current = yield* waitUntilPresent(
            observeDevice({
              id,
              name: output?.name,
              serialNumber,
              customer,
            }),
            serialNumber,
          ).pipe(
            Effect.catchTag("GCP.CloudIdentity.OperationPending", () =>
              observeDevice({ id, serialNumber, customer }),
            ),
          );
        }
      }

      if (current === undefined) {
        return yield* new DeviceNotResolved({
          name: output?.name ?? serialNumber,
        });
      }

      return toAttrs(current, customer);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      const deleted = yield* cloudidentity
        .deleteDevices({
          name: output.name,
          customer: normalizeCustomer(output.customer),
        })
        .pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed<cloudidentity.Operation | undefined>(undefined),
          ),
        );
      if (deleted !== undefined) {
        yield* waitForOperation(deleted, { notFoundOk: true });
      }
    }),
  });

const DEFAULT_CUSTOMER_FALLBACK = "customers/my_customer";
