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
  decodeSignedDevice,
  deviceBody,
  deviceConfigOf,
  deviceGrantsOf,
  deviceMetadataOf,
  encodeOwnershipLine,
  expandPath,
  findDeviceBySerial,
  findOwnedCustomerDeploymentDevice,
  frequencyRangesOf,
  getDeploymentDevice,
  hasOwnershipMarker,
  lastSegment,
  listCustomerDeploymentDevices,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  retryDelete,
  sameJson,
  sameText,
  scanOwnedCustomerDeploymentDevice,
  signedDeviceBody,
  toDisplayName,
  updateMaskOf,
  waitUntilGone,
  walkCustomerDeployments,
  type DeviceConfig,
  type DeviceGrant,
  type DeviceMetadata,
  type FrequencyRange,
} from "./internal.ts";

export type SignedCustomersDeploymentsDeviceProps = {
  /**
   * Parent SAS deployment, as `customers/{customer}/deployments/{deployment}`.
   * Immutable — changing it replaces the device.
   */
  parent: string;
  /**
   * Server-assigned device resource name
   * (`customers/{customer}/deployments/{deployment}/devices/{device}`). Immutable — changing it
   * replaces the device.
   */
  name?: string;
  /**
   * JSON Web Token signed with a CPI private key. Payload must be the
   * JSON encoding of the device. Create-only.
   */
  encodedDevice: string;
  /**
   * Unique installer id (CPI ID) from the Certified Professional
   * Installers database. Create-only.
   */
  installerId: string;
  /**
   * Display name. SAS Portal devices have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix after create and
   * strips it from attributes.
   */
  displayName?: string;
  /**
   * Manufacturer serial number, if known. Used to locate a device
   * after a signed create when ownership has not been stamped yet.
   */
  serialNumber?: string;
  /**
   * FCC identifier of the CBSD, if known.
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

export type SignedCustomersDeploymentsDevice = Resource<
  "GCP.SasPortal.SignedCustomersDeploymentsDevice",
  SignedCustomersDeploymentsDeviceProps,
  {
    /** Resource name `customers/{customer}/deployments/{deployment}/devices/{device}`. */
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
 * A CPI-signed Spectrum Access System (SAS) Portal CBSD under a customer deployment.
 *
 * Signed create takes a CPI-signed JWT. After the device exists,
 * Alchemy stamps ownership into `displayName` for `list` / nuke and
 * syncs mutable fields with the ordinary device patch API.
 *
 * ### Creating a Signed Device
 * **Example:** CPI-signed CBSD
 * ```typescript
 * const device = yield* GCP.SasPortal.SignedCustomersDeploymentsDevice("Cbsd", {
 *   parent: deployment.name,
 *   encodedDevice: jwt,
 *   installerId: "cpi-1",
 *   displayName: "rooftop-1",
 * });
 * ```
 *
 * ### Updating a Signed Device
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename
 * ```typescript
 * const device = yield* GCP.SasPortal.SignedCustomersDeploymentsDevice("Cbsd", {
 *   parent: deployment.name,
 *   encodedDevice: jwt,
 *   installerId: "cpi-1",
 *   displayName: "rooftop-2",
 * });
 * ```
 *
 * @resource
 * @category SasPortal
 */
export const SignedCustomersDeploymentsDevice =
  Resource<SignedCustomersDeploymentsDevice>(
    "GCP.SasPortal.SignedCustomersDeploymentsDevice",
  );

export class SignedCustomersDeploymentsDeviceNotResolved extends Data.TaggedError(
  "GCP.SasPortal.SignedCustomersDeploymentsDeviceNotResolved",
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

export const SignedCustomersDeploymentsDeviceProvider = () =>
  Provider.succeed(SignedCustomersDeploymentsDevice, {
    stables: ["name", "deviceId", "parent", "project", "serialNumber", "fccId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: expandPath(news.parent),
        previousId: olds?.name ?? output?.name,
        nextId: news.name,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandPath(olds?.parent ?? output?.parent ?? "");
      const name = olds?.name ?? output?.name ?? "";
      let existing = yield* getDeploymentDevice(name);
      let locatedParent = existing
        ? parentOf(existing.name ?? "") || parent
        : parent;
      if (existing === undefined) {
        const found =
          (yield* findOwnedCustomerDeploymentDevice(id, parent)) ??
          (yield* scanOwnedCustomerDeploymentDevice(id, parent));
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
        const parents = yield* walkCustomerDeployments();
        const pages = yield* Effect.forEach(
          parents,
          (entry) => {
            const parent = entry.deployment.name ?? "";
            return parent.length === 0
              ? Effect.succeed([])
              : listCustomerDeploymentDevices(parent).pipe(
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
      const decoded = yield* decodeSignedDevice(news.encodedDevice);
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(
          id,
          news.displayName ?? decoded?.displayName,
          output?.displayName,
        ),
        MAX_DISPLAY_NAME_LENGTH,
      );
      const serialNumber =
        news.serialNumber ?? output?.serialNumber ?? decoded?.serialNumber;
      const desired = deviceBody({
        displayName,
        serialNumber,
        fccId: news.fccId ?? output?.fccId ?? decoded?.fccId,
        grantRangeAllowlists: news.grantRangeAllowlists,
        preloadedConfig: news.preloadedConfig,
        deviceMetadata: news.deviceMetadata,
      });

      let current = yield* getDeploymentDevice(news.name ?? output?.name ?? "");
      if (current === undefined) {
        const found =
          (yield* findOwnedCustomerDeploymentDevice(id, parent)) ??
          (yield* scanOwnedCustomerDeploymentDevice(id, parent));
        current = found?.row;
      }
      if (current === undefined) {
        const rows = yield* listCustomerDeploymentDevices(parent);
        current = findDeviceBySerial(rows, serialNumber);
      }

      if (current === undefined) {
        const created = yield* sasportal
          .createSignedCustomersDeploymentsDevices({
            parent,
            body: signedDeviceBody({
              encodedDevice: news.encodedDevice,
              installerId: news.installerId,
            }),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.gen(function* () {
                const found = yield* findOwnedCustomerDeploymentDevice(
                  id,
                  parent,
                );
                if (found?.row !== undefined) return found.row;
                const rows = yield* listCustomerDeploymentDevices(parent);
                return findDeviceBySerial(rows, serialNumber);
              }),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SignedCustomersDeploymentsDeviceNotResolved({
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
        current = yield* sasportal.patchDeploymentsDevices({
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
        sasportal.deleteDeploymentsDevices({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getDeploymentDevice(output.name));
    }),
  });
