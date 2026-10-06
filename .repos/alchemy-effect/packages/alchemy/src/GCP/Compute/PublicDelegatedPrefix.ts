import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  normalizeRegion,
  parseDescription,
  runRegionOp,
  toPhysicalName,
} from "./internal.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type PublicDelegatedPrefixMode =
  | compute.PublicDelegatedPrefixModeEnum
  | (string & {});

export type PublicDelegatedPrefixProps = {
  /**
   * Prefix name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the prefix.
   */
  prefixName?: string;
  /**
   * Region the prefix lives in. Immutable — changing it replaces the
   * prefix. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Parent public advertised prefix or public delegated prefix URL.
   * Immutable — changing it replaces the prefix.
   */
  parentPrefix: string;
  /**
   * IP address range in CIDR format delegated from the parent. Immutable
   * — changing it replaces the prefix.
   */
  ipCidrRange: string;
  /**
   * IPv6-only mode (`DELEGATION`, `EXTERNAL_IPV6_FORWARDING_RULE_CREATION`,
   * `EXTERNAL_IPV6_SUBNETWORK_CREATION`, or
   * `INTERNAL_IPV6_SUBNETWORK_CREATION`). Immutable.
   */
  mode?: PublicDelegatedPrefixMode;
  /**
   * Allocatable prefix length supported by this PDP. Optional; cannot be
   * set for prefixes in `DELEGATION` mode or for IPv4 prefixes.
   */
  allocatablePrefixLength?: number;
  /**
   * If true, the prefix is a live-migration prefix. Immutable.
   */
  isLiveMigration?: boolean;
  /**
   * Optional description. Public delegated prefixes have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix for `list` /
   * nuke.
   */
  description?: string;
};

export type PublicDelegatedPrefix = Resource<
  "GCP.Compute.PublicDelegatedPrefix",
  PublicDelegatedPrefixProps,
  {
    /** Prefix name. */
    prefixName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Parent prefix URL. */
    parentPrefix: string | undefined;
    /** Delegated CIDR range. */
    ipCidrRange: string;
    /** IPv6 mode, if set. */
    mode: string | undefined;
    /** Allocatable prefix length. */
    allocatablePrefixLength: number | undefined;
    /** Whether this is a live-migration prefix. */
    isLiveMigration: boolean;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Provisioning status. */
    status: string | undefined;
    /** Child sub-prefixes. */
    publicDelegatedSubPrefixs: compute.PublicDelegatedPrefixPublicDelegatedSubPrefix[];
    /** IPv6 access type inherited from the parent. */
    ipv6AccessType: string | undefined;
    /** Whether enhanced IPv4 allocations are enabled. */
    enableEnhancedIpv4Allocation: boolean | undefined;
    /** BYOIP API version. */
    byoipApiVersion: string | undefined;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    prefixId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional public delegated prefix (BYOIP).
 *
 * A public delegated prefix is an IP block carved from a public advertised
 * prefix and scoped to one region (or global). Creating one requires a
 * parent advertised prefix. Name, region, parent, CIDR, and mode are
 * immutable. Description and sub-prefixes update in place via
 * `publicDelegatedPrefixes.patch`.
 *
 * ### Creating a Public Delegated Prefix
 * **Example:** Regional IPv4 sub-prefix
 * ```typescript
 * const pap = yield* GCP.Compute.PublicAdvertisedPrefix("Byoip", {
 *   ipCidrRange: "203.0.113.0/24",
 *   pdpScope: "REGIONAL",
 * });
 * const pdp = yield* GCP.Compute.PublicDelegatedPrefix("Delegate", {
 *   parentPrefix: pap.selfLink,
 *   ipCidrRange: "203.0.113.0/26",
 *   description: "us-central1 block",
 * });
 * ```
 *
 * **Example:** Explicit name
 * ```typescript
 * const pdp = yield* GCP.Compute.PublicDelegatedPrefix("Delegate", {
 *   prefixName: "lab-pdp",
 *   region: "us-central1",
 *   parentPrefix: pap.selfLink,
 *   ipCidrRange: "203.0.113.0/26",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const PublicDelegatedPrefix = Resource<PublicDelegatedPrefix>(
  "GCP.Compute.PublicDelegatedPrefix",
);

export class PublicDelegatedPrefixNotResolved extends Data.TaggedError(
  "GCP.Compute.PublicDelegatedPrefixNotResolved",
)<{
  prefixName: string;
  region: string;
}> {}

const toAttrs = (
  prefix: compute.PublicDelegatedPrefix,
  project: string,
): PublicDelegatedPrefix["Attributes"] => {
  const parsed = parseDescription(prefix.description);
  return {
    prefixName: prefix.name ?? lastSegment(prefix.selfLink),
    project,
    region: lastSegment(prefix.region).toLowerCase(),
    parentPrefix: prefix.parentPrefix,
    ipCidrRange: prefix.ipCidrRange ?? "",
    mode: prefix.mode,
    allocatablePrefixLength: prefix.allocatablePrefixLength,
    isLiveMigration: prefix.isLiveMigration === true,
    description: parsed.description,
    status: prefix.status,
    publicDelegatedSubPrefixs: prefix.publicDelegatedSubPrefixs ?? [],
    ipv6AccessType: prefix.ipv6AccessType,
    enableEnhancedIpv4Allocation: prefix.enableEnhancedIpv4Allocation,
    byoipApiVersion: prefix.byoipApiVersion,
    fingerprint: prefix.fingerprint,
    selfLink: prefix.selfLink,
    prefixId: prefix.id,
    creationTimestamp: prefix.creationTimestamp,
    kind: prefix.kind,
  };
};

const getByName = (project: string, region: string, name: string) =>
  compute
    .getPublicDelegatedPrefixes({
      project,
      region,
      publicDelegatedPrefix: name,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, region: string, prefixName: string) =>
  getByName(project, region, prefixName).pipe(
    Effect.flatMap((prefix) =>
      prefix !== undefined
        ? Effect.succeed(prefix)
        : Effect.fail(
            new PublicDelegatedPrefixNotResolved({ prefixName, region }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.PublicDelegatedPrefixNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const PublicDelegatedPrefixProvider = () =>
  Provider.succeed(PublicDelegatedPrefix, {
    stables: [
      "prefixName",
      "project",
      "region",
      "ipCidrRange",
      "prefixId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.prefixName ?? output?.prefixName;
      const nextName = news.prefixName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? (previousRegion || env.region),
        env.region,
      );
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const regionChanged =
        previousRegion.length > 0 && previousRegion !== nextRegion;
      const parentChanged =
        lastSegment(olds?.parentPrefix ?? output?.parentPrefix) !==
          lastSegment(news.parentPrefix) &&
        (olds?.parentPrefix ?? output?.parentPrefix) !== undefined;
      const cidrChanged =
        (olds?.ipCidrRange ?? output?.ipCidrRange) !== undefined &&
        news.ipCidrRange !== (olds?.ipCidrRange ?? output?.ipCidrRange);
      const modeChanged =
        news.mode !== undefined &&
        (olds?.mode ?? output?.mode) !== undefined &&
        news.mode !== (olds?.mode ?? output?.mode);
      if (
        nameChanged ||
        regionChanged ||
        parentChanged ||
        cidrChanged ||
        modeChanged
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            !nameChanged || nextName === undefined || nextName === previousName,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const prefixName = yield* toPhysicalName(
        id,
        olds?.prefixName,
        output?.prefixName,
        "prefix",
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, prefixName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListPublicDelegatedPrefixes
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.runCollect,
            Effect.catchTag("NotFound", () => Effect.succeed([] as never[])),
          );
        return Array.from(
          pages as readonly compute.PublicDelegatedPrefixAggregatedList[],
        ).flatMap((page) =>
          Object.entries(page.items ?? {}).flatMap(([scope, scoped]) => {
            if (!scope.startsWith("regions/")) return [];
            return (scoped?.publicDelegatedPrefixes ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project));
          }),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const prefixName = yield* toPhysicalName(
        id,
        news.prefixName,
        output?.prefixName,
        "prefix",
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(env.project, region, prefixName);

      if (current === undefined) {
        yield* runRegionOp(
          env.project,
          region,
          compute.insertPublicDelegatedPrefixes({
            project: env.project,
            region,
            body: {
              name: prefixName,
              description: desiredDescription,
              parentPrefix: news.parentPrefix,
              ipCidrRange: news.ipCidrRange,
              mode: news.mode,
              allocatablePrefixLength: news.allocatablePrefixLength,
              isLiveMigration: news.isLiveMigration,
            },
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(env.project, region, prefixName);
      }

      if (current === undefined) {
        return yield* new PublicDelegatedPrefixNotResolved({
          prefixName,
          region,
        });
      }

      if ((current.description ?? "") !== desiredDescription) {
        yield* runRegionOp(
          env.project,
          region,
          compute.patchPublicDelegatedPrefixes({
            project: env.project,
            region,
            publicDelegatedPrefix: prefixName,
            body: {
              description: desiredDescription,
              fingerprint: current.fingerprint,
            },
          }),
        );
        current =
          (yield* getByName(env.project, region, prefixName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      yield* runRegionOp(
        env.project,
        region,
        compute.deletePublicDelegatedPrefixes({
          project: env.project,
          region,
          publicDelegatedPrefix: output.prefixName,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }),
  });
