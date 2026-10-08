import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
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

const DEFAULT_ADDRESS_TYPE = "EXTERNAL";
const DEFAULT_IP_VERSION = "IPV4";
const DEFAULT_NETWORK_TIER = "PREMIUM";
const MAX_NAME_LENGTH = 63;

export type AddressProps = {
  /**
   * Name of the address. If omitted, a unique RFC1035 name is generated
   * from the stack, stage, and logical id. Immutable — changing it
   * replaces the address.
   */
  addressName?: string;
  /**
   * Region to reserve the address in. Immutable — changing it replaces
   * the address. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
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
   * `EXTERNAL` or `INTERNAL`. Immutable — changing it replaces the
   * address.
   * @default "EXTERNAL"
   */
  addressType?: compute.AddressAddressTypeEnum | (string & {});
  /**
   * `IPV4` or `IPV6`. Immutable — changing it replaces the address.
   * @default "IPV4"
   */
  ipVersion?: compute.AddressIpVersionEnum | (string & {});
  /**
   * Prefix length when the resource is an IP range. Immutable — changing
   * it replaces the address.
   */
  prefixLength?: number;
  /**
   * Purpose of an internal address (`GCE_ENDPOINT`, `DNS_RESOLVER`,
   * `VPC_PEERING`, `NAT_AUTO`, `IPSEC_INTERCONNECT`,
   * `SHARED_LOADBALANCER_VIP`, `PRIVATE_SERVICE_CONNECT`, `SERVERLESS`).
   * Immutable — changing it replaces the address.
   */
  purpose?: compute.AddressPurposeEnum | (string & {});
  /**
   * Network URL for internal addresses (`VPC_PEERING` /
   * `IPSEC_INTERCONNECT`). Immutable — changing it replaces the address.
   */
  network?: string;
  /**
   * Subnetwork URL for internal `GCE_ENDPOINT` / `DNS_RESOLVER`
   * addresses. Immutable — changing it replaces the address.
   */
  subnetwork?: string;
  /**
   * Networking tier (`PREMIUM` or `STANDARD`). Internal addresses are
   * always Premium. Immutable — changing it replaces the address.
   * @default "PREMIUM"
   */
  networkTier?: compute.AddressNetworkTierEnum | (string & {});
  /**
   * Endpoint type for reserved IPv6 addresses (`VM` or `NETLB`).
   * Immutable — changing it replaces the address.
   */
  ipv6EndpointType?: compute.AddressIpv6EndpointTypeEnum | (string & {});
  /**
   * Public delegated prefix used to draw a BYOIP address. Immutable —
   * changing it replaces the address.
   */
  ipCollection?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
};

export type Address = Resource<
  "GCP.Compute.Address",
  AddressProps,
  {
    /** Address name. */
    addressName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Reserved IP address or start of the range. */
    address: string | undefined;
    /** Server-assigned numeric id. */
    addressId: string | undefined;
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
    /** Subnetwork URL, if any. */
    subnetwork: string | undefined;
    /** Networking tier. */
    networkTier: string | undefined;
    /** IPv6 endpoint type, if any. */
    ipv6EndpointType: string | undefined;
    /** BYOIP public delegated prefix, if any. */
    ipCollection: string | undefined;
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
 * A regional Compute Engine static IP address.
 *
 * Reserves a regional internal or external IP. Labels are the only
 * in-place update (`addresses.setLabels`); name, region, IP, type,
 * version, purpose, network, subnetwork, prefix length, and description
 * replace the address.
 *
 * ### Creating an Address
 * **Example:** Generated name
 * ```typescript
 * const ip = yield* GCP.Compute.Address("Ingress", {});
 * ```
 *
 * **Example:** Named address with labels
 * ```typescript
 * const ip = yield* GCP.Compute.Address("Ingress", {
 *   addressName: "app-ingress",
 *   region: "us-central1",
 *   addressType: "EXTERNAL",
 *   networkTier: "PREMIUM",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Internal Addresses
 * **Example:** Regional internal IP in a subnetwork
 * ```typescript
 * const ip = yield* GCP.Compute.Address("ServiceIp", {
 *   region: "us-central1",
 *   addressType: "INTERNAL",
 *   subnetwork:
 *     "projects/my-project/regions/us-central1/subnetworks/default",
 *   purpose: "GCE_ENDPOINT",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Address = Resource<Address>("GCP.Compute.Address");

export class AddressNotResolved extends Data.TaggedError(
  "GCP.Compute.AddressNotResolved",
)<{
  addressName: string;
  region: string;
}> {}

export class AddressPending extends Data.TaggedError(
  "GCP.Compute.AddressPending",
)<{
  addressName: string;
  status: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const resourceRefOf = (value: string | undefined) => {
  if (!value) return "";
  return lastSegment(value);
};

const addressTypeOf = (value: string | undefined) =>
  value && value !== "UNSPECIFIED_TYPE" ? value : DEFAULT_ADDRESS_TYPE;

const ipVersionOf = (value: string | undefined) =>
  value && value !== "UNSPECIFIED_VERSION" ? value : DEFAULT_IP_VERSION;

const networkTierOf = (value: string | undefined) =>
  value ?? DEFAULT_NETWORK_TIER;

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
  region: lastSegment(address.region ?? "").toLowerCase(),
  address: address.address,
  addressId: address.id,
  selfLink: address.selfLink,
  status: address.status,
  addressType: address.addressType,
  ipVersion: address.ipVersion,
  prefixLength: address.prefixLength,
  purpose: address.purpose,
  network: address.network,
  subnetwork: address.subnetwork,
  networkTier: address.networkTier,
  ipv6EndpointType: address.ipv6EndpointType,
  ipCollection: address.ipCollection,
  description: address.description,
  labels: userLabels(address.labels),
  creationTimestamp: address.creationTimestamp,
  users: address.users ?? [],
});

const getByName = (project: string, region: string, address: string) =>
  compute
    .getAddresses({ project, region, address })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (project: string, region: string, addressName: string) =>
  getByName(project, region, addressName).pipe(
    Effect.flatMap((address) => {
      if (address === undefined || address.status === "RESERVING") {
        return Effect.fail(
          new AddressPending({
            addressName,
            status: address?.status ?? "MISSING",
          }),
        );
      }
      return Effect.succeed(address);
    }),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.AddressPending",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const requireAddress = (project: string, region: string, addressName: string) =>
  getByName(project, region, addressName).pipe(
    Effect.flatMap((address) =>
      address
        ? Effect.succeed(address)
        : Effect.fail(new AddressNotResolved({ addressName, region })),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.AddressNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilGone = (project: string, region: string, addressName: string) =>
  getByName(project, region, addressName).pipe(
    Effect.flatMap((address) =>
      address === undefined
        ? Effect.void
        : Effect.fail(
            new AddressPending({
              addressName,
              status: address.status ?? "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.AddressPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const AddressProvider = () =>
  Provider.succeed(Address, {
    stables: [
      "addressName",
      "project",
      "region",
      "address",
      "addressId",
      "selfLink",
      "addressType",
      "ipVersion",
      "prefixLength",
      "purpose",
      "network",
      "subnetwork",
      "networkTier",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds.addressName ?? output?.addressName;
      const nextName = news.addressName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;

      const previousRegion = normalizeRegion(
        olds.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;

      const previousType = addressTypeOf(
        olds.addressType ?? output?.addressType,
      );
      const previousVersion = ipVersionOf(olds.ipVersion ?? output?.ipVersion);
      const previousTier = networkTierOf(
        olds.networkTier ?? output?.networkTier,
      );
      const previousNetwork = resourceRefOf(olds.network ?? output?.network);
      const previousSubnetwork = resourceRefOf(
        olds.subnetwork ?? output?.subnetwork,
      );
      const previousPurpose = olds.purpose ?? output?.purpose ?? "";
      const previousDescription = olds.description ?? output?.description ?? "";
      const previousPrefix = olds.prefixLength ?? output?.prefixLength;
      const previousIpv6 =
        olds.ipv6EndpointType ?? output?.ipv6EndpointType ?? "";
      const previousCollection = resourceRefOf(
        olds.ipCollection ?? output?.ipCollection,
      );

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
        (news.subnetwork !== undefined &&
          resourceRefOf(news.subnetwork) !== previousSubnetwork) ||
        (news.networkTier !== undefined &&
          networkTierOf(news.networkTier) !== previousTier) ||
        (news.ipv6EndpointType !== undefined &&
          (news.ipv6EndpointType ?? "") !== previousIpv6) ||
        (news.ipCollection !== undefined &&
          resourceRefOf(news.ipCollection) !== previousCollection);

      if (nameChanged || regionChanged) {
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
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, addressName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListAddresses
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.addresses ?? [])
              .filter((item) => item.region !== undefined)
              .filter((item) =>
                Object.keys(item.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const addressName = yield* toName(
        id,
        news.addressName,
        output?.addressName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, addressName);

      if (current === undefined) {
        const created = yield* compute
          .insertAddresses({
            project: env.project,
            region,
            body: {
              name: addressName,
              description: news.description,
              address: news.address,
              addressType: news.addressType,
              ipVersion: news.ipVersion,
              prefixLength: news.prefixLength,
              purpose: news.purpose,
              network: news.network,
              subnetwork: news.subnetwork,
              networkTier: news.networkTier,
              ipv6EndpointType: news.ipv6EndpointType,
              ipCollection: news.ipCollection,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() =>
                  requireAddress(env.project, region, addressName),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              getByName(env.project, region, addressName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AddressNotResolved({ addressName, region });
      }

      if (current.status === "RESERVING") {
        current = yield* waitUntilReady(env.project, region, addressName);
      }

      const resolved = current;
      const observedLabels = tagRecord(resolved.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* Effect.gen(function* () {
          const latest =
            (yield* getByName(env.project, region, addressName)) ?? resolved;
          yield* compute
            .setLabelsAddresses({
              project: env.project,
              region,
              resource: addressName,
              body: {
                labels: desiredLabels,
                labelFingerprint: latest.labelFingerprint,
              },
            })
            .pipe(
              Effect.flatMap((operation) =>
                waitRegionOperation(env.project, region, operation),
              ),
            );
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 5,
            schedule: Schedule.spaced("1 second"),
          }),
        );
        current =
          (yield* getByName(env.project, region, addressName)) ?? resolved;
      }

      return toAttrs(current ?? resolved, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      yield* compute
        .deleteAddresses({
          project,
          region,
          address: output.addressName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
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
      yield* waitUntilGone(project, region, output.addressName);
    }),
  });
