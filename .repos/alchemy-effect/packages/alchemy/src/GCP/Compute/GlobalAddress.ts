import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitGlobalOperation } from "./operations.ts";

const DEFAULT_ADDRESS_TYPE = "EXTERNAL";
const DEFAULT_IP_VERSION = "IPV4";
const DEFAULT_NETWORK_TIER = "PREMIUM";
const MAX_NAME_LENGTH = 63;

export type GlobalAddressProps = {
  /**
   * Name of the address. If omitted, a unique RFC1035 name is generated
   * from the stack, stage, and logical id. Immutable — changing it
   * replaces the address.
   */
  addressName?: string;
  /**
   * Optional description. Immutable — changing it replaces the address.
   */
  description?: string;
  /**
   * Specific IP to reserve. If omitted, GCP assigns one. Immutable —
   * changing it replaces the address.
   */
  address?: string;
  /**
   * `EXTERNAL` (global anycast) or `INTERNAL` (VPC peering / PSC).
   * Immutable — changing it replaces the address.
   * @default "EXTERNAL"
   */
  addressType?: compute.AddressAddressTypeEnum | (string & {});
  /**
   * `IPV4` or `IPV6`. Immutable — changing it replaces the address.
   * @default "IPV4"
   */
  ipVersion?: compute.AddressIpVersionEnum | (string & {});
  /**
   * Prefix length when the resource is an IP range (VPC peering /
   * PSC). Immutable — changing it replaces the address.
   */
  prefixLength?: number;
  /**
   * Purpose of an internal address (`VPC_PEERING`,
   * `PRIVATE_SERVICE_CONNECT`, …). Immutable — changing it replaces
   * the address.
   */
  purpose?: compute.AddressPurposeEnum | (string & {});
  /**
   * Network URL for internal addresses (`VPC_PEERING` /
   * `PRIVATE_SERVICE_CONNECT`). Immutable — changing it replaces the
   * address.
   */
  network?: string;
  /**
   * Networking tier. Global external addresses are always `PREMIUM`.
   * Immutable — changing it replaces the address.
   * @default "PREMIUM"
   */
  networkTier?: compute.AddressNetworkTierEnum | (string & {});
  /**
   * Endpoint type for reserved IPv6 addresses (`VM` or `NETLB`).
   * Immutable — changing it replaces the address.
   */
  ipv6EndpointType?: compute.AddressIpv6EndpointTypeEnum | (string & {});
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
};

export type GlobalAddress = Resource<
  "GCP.Compute.GlobalAddress",
  GlobalAddressProps,
  {
    /** Address name. */
    addressName: string;
    /** Project id. */
    project: string;
    /** Reserved IP address or start of the range. */
    address: string | undefined;
    /** Server-assigned numeric id. */
    id: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** `RESERVING`, `RESERVED`, or `IN_USE`. */
    status: string | undefined;
    /** `EXTERNAL` or `INTERNAL`. */
    addressType: string | undefined;
    /** `IPV4` or `IPV6`. */
    ipVersion: string | undefined;
    /** Prefix length of an IP range, if any. */
    prefixLength: number | undefined;
    /** Purpose of an internal address, if any. */
    purpose: string | undefined;
    /** Network URL for internal addresses, if any. */
    network: string | undefined;
    /** Networking tier. */
    networkTier: string | undefined;
    /** IPv6 endpoint type, if any. */
    ipv6EndpointType: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Self-links of resources using this address. */
    users: ReadonlyArray<string>;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine address — a reserved anycast IP for global
 * forwarding rules, or an internal range for VPC peering / Private
 * Service Connect.
 *
 * Labels are the only in-place update. Name, IP, type, version,
 * purpose, network, prefix length, and description replace the
 * address.
 *
 * ### Creating a Global Address
 * **Example:** Generated name
 * ```typescript
 * const ip = yield* GCP.Compute.GlobalAddress("FrontendIp", {});
 * ```
 *
 * **Example:** Named address with labels
 * ```typescript
 * const ip = yield* GCP.Compute.GlobalAddress("FrontendIp", {
 *   addressName: "app-lb-ip",
 *   description: "Global anycast IP for the HTTPS load balancer",
 *   ipVersion: "IPV4",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Internal Ranges
 * **Example:** VPC peering range
 * ```typescript
 * const range = yield* GCP.Compute.GlobalAddress("PsaRange", {
 *   addressType: "INTERNAL",
 *   purpose: "VPC_PEERING",
 *   network: "projects/my-project/global/networks/main",
 *   prefixLength: 16,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const GlobalAddress = Resource<GlobalAddress>(
  "GCP.Compute.GlobalAddress",
);

export class GlobalAddressNotResolved extends Data.TaggedError(
  "GCP.Compute.GlobalAddressNotResolved",
)<{
  addressName: string;
}> {}

export class GlobalAddressPending extends Data.TaggedError(
  "GCP.Compute.GlobalAddressPending",
)<{
  addressName: string;
  status: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `a${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (address: compute.Address, project: string) => ({
  addressName: address.name ?? "",
  project,
  address: address.address,
  id: address.id,
  selfLink: address.selfLink,
  status: address.status,
  addressType: address.addressType,
  ipVersion: address.ipVersion,
  prefixLength: address.prefixLength,
  purpose: address.purpose,
  network: address.network,
  networkTier: address.networkTier,
  ipv6EndpointType: address.ipv6EndpointType,
  description: address.description,
  labels: userLabels(address.labels),
  creationTimestamp: address.creationTimestamp,
  users: address.users ?? [],
});

const addressTypeOf = (value: string | undefined) =>
  value && value !== "UNSPECIFIED_TYPE" ? value : DEFAULT_ADDRESS_TYPE;

const ipVersionOf = (value: string | undefined) =>
  value && value !== "UNSPECIFIED_VERSION" ? value : DEFAULT_IP_VERSION;

const networkTierOf = (value: string | undefined) =>
  value ?? DEFAULT_NETWORK_TIER;

const resourceRefOf = (value: string | undefined) => {
  if (!value) return "";
  const parts = value.split("/");
  return parts[parts.length - 1] ?? value;
};

const getByName = (project: string, address: string) =>
  compute
    .getGlobalAddresses({ project, address })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (project: string, addressName: string) =>
  getByName(project, addressName).pipe(
    Effect.flatMap((address) => {
      if (address === undefined || address.status === "RESERVING") {
        return Effect.fail(
          new GlobalAddressPending({
            addressName,
            status: address?.status ?? "MISSING",
          }),
        );
      }
      return Effect.succeed(address);
    }),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.GlobalAddressPending",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (project: string, addressName: string) =>
  getByName(project, addressName).pipe(
    Effect.flatMap((address) =>
      address === undefined
        ? Effect.void
        : Effect.fail(
            new GlobalAddressPending({
              addressName,
              status: address.status ?? "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.GlobalAddressPending",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("GCP.Compute.GlobalAddressPending", () => Effect.void),
  );

export const GlobalAddressProvider = () =>
  Provider.succeed(GlobalAddress, {
    stables: [
      "addressName",
      "project",
      "address",
      "id",
      "selfLink",
      "addressType",
      "ipVersion",
      "prefixLength",
      "purpose",
      "network",
      "networkTier",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds.addressName ?? output?.addressName;
      const nextName = news.addressName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;

      const previousType = addressTypeOf(
        olds.addressType ?? output?.addressType,
      );
      const previousVersion = ipVersionOf(olds.ipVersion ?? output?.ipVersion);
      const previousTier = networkTierOf(
        olds.networkTier ?? output?.networkTier,
      );
      const previousNetwork = resourceRefOf(olds.network ?? output?.network);
      const previousPurpose = olds.purpose ?? output?.purpose ?? "";
      const previousDescription = olds.description ?? output?.description ?? "";
      const previousPrefix = olds.prefixLength ?? output?.prefixLength;
      const previousIpv6 =
        olds.ipv6EndpointType ?? output?.ipv6EndpointType ?? "";

      const immutableChanged =
        (news.description !== undefined &&
          (news.description ?? "") !== previousDescription) ||
        (news.address !== undefined &&
          output?.address !== undefined &&
          news.address !== output.address) ||
        (news.addressType !== undefined &&
          addressTypeOf(news.addressType) !== previousType) ||
        (news.ipVersion !== undefined &&
          ipVersionOf(news.ipVersion) !== previousVersion) ||
        (news.prefixLength !== undefined &&
          news.prefixLength !== previousPrefix) ||
        (news.purpose !== undefined &&
          (news.purpose ?? "") !== previousPurpose) ||
        (news.network !== undefined &&
          resourceRefOf(news.network) !== previousNetwork) ||
        (news.networkTier !== undefined &&
          networkTierOf(news.networkTier) !== previousTier) ||
        (news.ipv6EndpointType !== undefined &&
          (news.ipv6EndpointType ?? "") !== previousIpv6);

      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const addressName = yield* toName(
        id,
        olds?.addressName,
        output?.addressName,
      );
      const existing = yield* getByName(env.project, addressName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listGlobalAddresses
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((address) =>
              Object.keys(address.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((address) => toAttrs(address, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const addressName = yield* toName(
        id,
        news.addressName,
        output?.addressName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, addressName);

      if (current === undefined) {
        const created = yield* compute
          .insertGlobalAddresses({
            project: env.project,
            body: {
              name: addressName,
              description: news.description,
              address: news.address,
              addressType: news.addressType,
              ipVersion: news.ipVersion,
              prefixLength: news.prefixLength,
              purpose: news.purpose,
              network: news.network,
              networkTier: news.networkTier,
              ipv6EndpointType: news.ipv6EndpointType,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() => getByName(env.project, addressName)),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              getByName(env.project, addressName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new GlobalAddressNotResolved({ addressName });
      }

      if (current.status === "RESERVING") {
        current = yield* waitUntilReady(env.project, addressName);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* compute
          .setLabelsGlobalAddresses({
            project: env.project,
            resource: addressName,
            body: {
              labels: desiredLabels,
              labelFingerprint: current.labelFingerprint,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = (yield* getByName(env.project, addressName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      yield* compute
        .deleteGlobalAddresses({
          project: env.project,
          address: output.addressName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitGlobalOperation(env.project, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(env.project, output.addressName);
    }),
  });
