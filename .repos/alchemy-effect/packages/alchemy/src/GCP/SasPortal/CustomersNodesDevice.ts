import * as sasportal from "@distilled.cloud/gcp/sasportal_v1alpha1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  deviceBody,
  deviceConfigOf,
  deviceGrantsOf,
  deviceMetadataOf,
  encodeOwnershipLine,
  expandPath,
  findOwnedCustomerNodeDevice,
  frequencyRangesOf,
  getNodeDevice,
  hasOwnershipMarker,
  lastSegment,
  listCustomerNodeDevices,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  retryDelete,
  sameJson,
  sameText,
  scanOwnedCustomerNodeDevice,
  toDisplayName,
  toSerialNumber,
  updateMaskOf,
  waitUntilGone,
  walkCustomerNodes,
  type DeviceConfig,
  type DeviceGrant,
  type DeviceMetadata,
  type FrequencyRange,
} from "./internal.ts";

export type CustomersNodesDeviceProps = {
  /**
   * Parent SAS node, as `customers/{customer}/nodes/{node}`.
   * Immutable — changing it replaces the device.
   */
  parent: string;
  /**
   * Server-assigned device resource name
   * (`customers/{customer}/nodes/{node}/devices/{device}`). Immutable — changing it
   * replaces the device.
   */
  name?: string;
  /**
   * Display name. SAS Portal devices have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  displayName?: string;
  /**
   * Manufacturer serial number. Immutable — changing it replaces the
   * device.
   */
  serialNumber?: string;
  /**
   * FCC identifier of the CBSD. Immutable — changing it replaces the
   * device.
   */
  fccId?: string;
  /**
   * Frequency ranges available for new grants.
   */
  grantRangeAllowlists?: FrequencyRange[];
  /**
   * Device configuration supplied through the SAS Portal API.
   */
  preloadedConfig?: DeviceConfig;
  /**
   * Overridable device metadata (ICG, CCG, antenna model).
   */
  deviceMetadata?: DeviceMetadata;
};

export type CustomersNodesDevice = Resource<
  "GCP.SasPortal.CustomersNodesDevice",
  CustomersNodesDeviceProps,
  {
    /** Resource name `customers/{customer}/nodes/{node}/devices/{device}`. */
    name: string;
    /** Device id (last path segment). */
    deviceId: string;
    /** Parent resource name. */
    parent: string;
    /** Project id used when the device was reconciled. */
    project: string;
    /** User-facing display name with the Alchemy prefix stripped. */
    displayName: string | undefined;
    /** Manufacturer serial number. */
    serialNumber: string | undefined;
    /** FCC identifier. */
    fccId: string | undefined;
    /** Grant-range allowlists. */
    grantRangeAllowlists: FrequencyRange[] | undefined;
    /** Portal-supplied configuration. */
    preloadedConfig: DeviceConfig | undefined;
    /** Current SAS-registered configuration. */
    activeConfig: DeviceConfig | undefined;
    /** Overridable device metadata. */
    deviceMetadata: DeviceMetadata | undefined;
    /** Device state. */
    state: string | undefined;
    /** Grants held by the device. */
    grants: DeviceGrant[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Spectrum Access System (SAS) Portal CBSD under a customer node.
 *
 * SAS Portal devices have no labels field, so Alchemy stamps ownership
 * into `displayName` for `list` / nuke. Parent, FCC id, and serial
 * number are identity. Display name, grant allowlists, preloaded
 * config, and metadata update in place.
 *
 * ### Creating a Device
 * **Example:** Category A CBSD
 * ```typescript
 * const device = yield* GCP.SasPortal.CustomersNodesDevice("Cbsd", {
 *   parent: node.name,
 *   displayName: "sector-a",
 *   fccId: "TESTFCC",
 *   serialNumber: "SN1001",
 * });
 * ```
 *
 * ### Updating a Device
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename
 * ```typescript
 * const device = yield* GCP.SasPortal.CustomersNodesDevice("Cbsd", {
 *   parent: node.name,
 *   displayName: "sector-a-2",
 *   fccId: "TESTFCC",
 *   serialNumber: "SN1001",
 * });
 * ```
 *
 * @resource
 * @category SasPortal
 */
export const CustomersNodesDevice = Resource<CustomersNodesDevice>(
  "GCP.SasPortal.CustomersNodesDevice",
);

export class CustomersNodesDeviceNotResolved extends Data.TaggedError(
  "GCP.SasPortal.CustomersNodesDeviceNotResolved",
)<{
  parent: string;
  name: string;
}> {}

const toAttrs = (
  device: sasportal.SasPortalDevice,
  parent: string,
  project: string,
) => {
  const name = device.name ?? "";
  return {
    name,
    deviceId: lastSegment(name),
    parent: parentOf(name) || parent,
    project,
    displayName: parseOwnership(device.displayName).text,
    serialNumber: device.serialNumber,
    fccId: device.fccId,
    grantRangeAllowlists: frequencyRangesOf(device.grantRangeAllowlists),
    preloadedConfig: deviceConfigOf(device.preloadedConfig),
    activeConfig: deviceConfigOf(device.activeConfig),
    deviceMetadata: deviceMetadataOf(device.deviceMetadata),
    state: device.state,
    grants: deviceGrantsOf(device.grants),
  };
};

export const CustomersNodesDeviceProvider = () =>
  Provider.succeed(CustomersNodesDevice, {
    stables: ["name", "deviceId", "parent", "project", "serialNumber", "fccId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: expandPath(news.parent),
        previousId: olds?.name ?? output?.name,
        nextId: news.name,
        extra:
          (news.serialNumber !== undefined &&
            output?.serialNumber !== undefined &&
            news.serialNumber !== output.serialNumber) ||
          (news.fccId !== undefined &&
            output?.fccId !== undefined &&
            news.fccId !== output.fccId),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandPath(olds?.parent ?? output?.parent ?? "");
      const name = olds?.name ?? output?.name ?? "";
      let existing = yield* getNodeDevice(name);
      let locatedParent = existing
        ? parentOf(existing.name ?? "") || parent
        : parent;
      if (existing === undefined) {
        const found =
          (yield* findOwnedCustomerNodeDevice(id, parent)) ??
          (yield* scanOwnedCustomerNodeDevice(id, parent));
        existing = found?.row;
        locatedParent = found?.parent ?? locatedParent;
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, locatedParent, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parents = yield* walkCustomerNodes();
        const pages = yield* Effect.forEach(
          parents,
          (entry) => {
            const parent = entry.node.name ?? "";
            return parent.length === 0
              ? Effect.succeed([])
              : listCustomerNodeDevices(parent).pipe(
                  Effect.map((rows) =>
                    rows
                      .filter((row) => hasOwnershipMarker(row.displayName))
                      .map((row) => toAttrs(row, parent, env.project)),
                  ),
                );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandPath(news.parent);
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(id, news.displayName, output?.displayName),
        MAX_DISPLAY_NAME_LENGTH,
      );
      const serialNumber = yield* toSerialNumber(
        id,
        news.serialNumber,
        output?.serialNumber,
      );
      const desired = deviceBody({
        displayName,
        serialNumber,
        fccId: news.fccId ?? output?.fccId,
        grantRangeAllowlists: news.grantRangeAllowlists,
        preloadedConfig: news.preloadedConfig,
        deviceMetadata: news.deviceMetadata,
      });

      let current = yield* getNodeDevice(news.name ?? output?.name ?? "");
      if (current === undefined) {
        const found =
          (yield* findOwnedCustomerNodeDevice(id, parent)) ??
          (yield* scanOwnedCustomerNodeDevice(id, parent));
        current = found?.row;
      }

      if (current === undefined) {
        const created = yield* sasportal
          .createCustomersNodesDevices({
            parent,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedCustomerNodeDevice(id, parent).pipe(
                Effect.map((found) => found?.row),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersNodesDeviceNotResolved({
          parent,
          name: news.name ?? output?.name ?? displayName,
        });
      }

      const name = current.name ?? news.name ?? output?.name ?? "";
      const nameChanged = !sameText(current.displayName, displayName);
      const allowlistsChanged =
        news.grantRangeAllowlists !== undefined &&
        !sameJson(
          frequencyRangesOf(current.grantRangeAllowlists),
          news.grantRangeAllowlists,
        );
      const configChanged =
        news.preloadedConfig !== undefined &&
        !sameJson(
          deviceConfigOf(current.preloadedConfig),
          news.preloadedConfig,
        );
      const metadataChanged =
        news.deviceMetadata !== undefined &&
        !sameJson(
          deviceMetadataOf(current.deviceMetadata),
          news.deviceMetadata,
        );
      if (
        nameChanged ||
        allowlistsChanged ||
        configChanged ||
        metadataChanged
      ) {
        current = yield* sasportal.patchNodesDevices({
          name,
          updateMask: updateMaskOf(
            "displayName",
            news.grantRangeAllowlists !== undefined
              ? "grantRangeAllowlists"
              : undefined,
            news.preloadedConfig !== undefined ? "preloadedConfig" : undefined,
            news.deviceMetadata !== undefined ? "deviceMetadata" : undefined,
          ),
          body: desired,
        });
      }

      return toAttrs(current, parent, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryDelete(
        sasportal.deleteNodesDevices({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getNodeDevice(output.name));
    }),
  });
