import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  parseDescription,
  runGlobalOp,
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

export type PublicAdvertisedPrefixPdpScope =
  | compute.PublicAdvertisedPrefixPdpScopeEnum
  | (string & {});
export type PublicAdvertisedPrefixIpv6AccessType =
  | compute.PublicAdvertisedPrefixIpv6AccessTypeEnum
  | (string & {});

export type PublicAdvertisedPrefixProps = {
  /**
   * Prefix name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the prefix.
   */
  prefixName?: string;
  /**
   * The address range in CIDR format represented by this public advertised
   * prefix. Immutable — changing it replaces the prefix.
   */
  ipCidrRange: string;
  /**
   * Address used for reverse DNS verification. Immutable — changing it
   * replaces the prefix.
   */
  dnsVerificationIp?: string;
  /**
   * How child public delegated prefixes are scoped (`REGIONAL` or
   * `GLOBAL`). Immutable — changing it replaces the prefix.
   */
  pdpScope?: PublicAdvertisedPrefixPdpScope;
  /**
   * Internet access type for IPv6 prefixes (`EXTERNAL` or `INTERNAL`).
   * Immutable — changing it replaces the prefix.
   */
  ipv6AccessType?: PublicAdvertisedPrefixIpv6AccessType;
  /**
   * Optional description. Public advertised prefixes have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix for
   * `list` / nuke.
   */
  description?: string;
};

export type PublicAdvertisedPrefix = Resource<
  "GCP.Compute.PublicAdvertisedPrefix",
  PublicAdvertisedPrefixProps,
  {
    /** Prefix name. */
    prefixName: string;
    /** Project id. */
    project: string;
    /** Advertised CIDR range. */
    ipCidrRange: string;
    /** Reverse-DNS verification address. */
    dnsVerificationIp: string | undefined;
    /** Child PDP scope. */
    pdpScope: string | undefined;
    /** IPv6 access type. */
    ipv6AccessType: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Provisioning status. */
    status: string | undefined;
    /** Shared secret for reverse DNS verification. */
    sharedSecret: string | undefined;
    /** Child public delegated prefixes. */
    publicDelegatedPrefixs: compute.PublicAdvertisedPrefixPublicDelegatedPrefix[];
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
 * A global public advertised prefix (BYOIP).
 *
 * A public advertised prefix is an aggregated IP prefix you bring to
 * Google Cloud. Creating one requires a prefix you own and reverse-DNS
 * verification. Name, CIDR, verification IP, and PDP scope are immutable.
 * Description updates in place via `publicAdvertisedPrefixes.patch`.
 *
 * ### Creating a Public Advertised Prefix
 * **Example:** Regional-scope IPv4 prefix
 * ```typescript
 * const prefix = yield* GCP.Compute.PublicAdvertisedPrefix("Byoip", {
 *   ipCidrRange: "203.0.113.0/24",
 *   dnsVerificationIp: "203.0.113.1",
 *   pdpScope: "REGIONAL",
 *   description: "lab prefix",
 * });
 * ```
 *
 * **Example:** Explicit name
 * ```typescript
 * const prefix = yield* GCP.Compute.PublicAdvertisedPrefix("Byoip", {
 *   prefixName: "lab-pap",
 *   ipCidrRange: "203.0.113.0/24",
 *   pdpScope: "REGIONAL",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const PublicAdvertisedPrefix = Resource<PublicAdvertisedPrefix>(
  "GCP.Compute.PublicAdvertisedPrefix",
);

export class PublicAdvertisedPrefixNotResolved extends Data.TaggedError(
  "GCP.Compute.PublicAdvertisedPrefixNotResolved",
)<{
  prefixName: string;
}> {}

const toAttrs = (
  prefix: compute.PublicAdvertisedPrefix,
  project: string,
): PublicAdvertisedPrefix["Attributes"] => {
  const parsed = parseDescription(prefix.description);
  return {
    prefixName: prefix.name ?? lastSegment(prefix.selfLink),
    project,
    ipCidrRange: prefix.ipCidrRange ?? "",
    dnsVerificationIp: prefix.dnsVerificationIp,
    pdpScope: prefix.pdpScope,
    ipv6AccessType: prefix.ipv6AccessType,
    description: parsed.description,
    status: prefix.status,
    sharedSecret: prefix.sharedSecret,
    publicDelegatedPrefixs: prefix.publicDelegatedPrefixs ?? [],
    byoipApiVersion: prefix.byoipApiVersion,
    fingerprint: prefix.fingerprint,
    selfLink: prefix.selfLink,
    prefixId: prefix.id,
    creationTimestamp: prefix.creationTimestamp,
    kind: prefix.kind,
  };
};

const getByName = (project: string, publicAdvertisedPrefix: string) =>
  compute
    .getPublicAdvertisedPrefixes({ project, publicAdvertisedPrefix })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, prefixName: string) =>
  getByName(project, prefixName).pipe(
    Effect.flatMap((prefix) =>
      prefix !== undefined
        ? Effect.succeed(prefix)
        : Effect.fail(new PublicAdvertisedPrefixNotResolved({ prefixName })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.PublicAdvertisedPrefixNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const PublicAdvertisedPrefixProvider = () =>
  Provider.succeed(PublicAdvertisedPrefix, {
    stables: [
      "prefixName",
      "project",
      "ipCidrRange",
      "prefixId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.prefixName ?? output?.prefixName;
      const nextName = news.prefixName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const cidrChanged =
        (olds?.ipCidrRange ?? output?.ipCidrRange) !== undefined &&
        news.ipCidrRange !== (olds?.ipCidrRange ?? output?.ipCidrRange);
      const dnsChanged =
        news.dnsVerificationIp !== undefined &&
        (olds?.dnsVerificationIp ?? output?.dnsVerificationIp) !== undefined &&
        news.dnsVerificationIp !==
          (olds?.dnsVerificationIp ?? output?.dnsVerificationIp);
      const scopeChanged =
        news.pdpScope !== undefined &&
        (olds?.pdpScope ?? output?.pdpScope) !== undefined &&
        news.pdpScope !== (olds?.pdpScope ?? output?.pdpScope);
      if (nameChanged || cidrChanged || dnsChanged || scopeChanged) {
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
      const existing = yield* getByName(env.project, prefixName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listPublicAdvertisedPrefixes
          .items({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.filter((item) => hasOwnershipMarker(item.description)),
            Stream.map((item) => toAttrs(item, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as PublicAdvertisedPrefix["Attributes"][]),
            ),
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
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(env.project, prefixName);

      if (current === undefined) {
        yield* runGlobalOp(
          env.project,
          compute.insertPublicAdvertisedPrefixes({
            project: env.project,
            body: {
              name: prefixName,
              description: desiredDescription,
              ipCidrRange: news.ipCidrRange,
              dnsVerificationIp: news.dnsVerificationIp,
              pdpScope: news.pdpScope,
              ipv6AccessType: news.ipv6AccessType,
            },
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(env.project, prefixName);
      }

      if (current === undefined) {
        return yield* new PublicAdvertisedPrefixNotResolved({ prefixName });
      }

      if ((current.description ?? "") !== desiredDescription) {
        yield* runGlobalOp(
          env.project,
          compute.patchPublicAdvertisedPrefixes({
            project: env.project,
            publicAdvertisedPrefix: prefixName,
            body: {
              description: desiredDescription,
              fingerprint: current.fingerprint,
            },
          }),
        );
        current = (yield* getByName(env.project, prefixName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      yield* runGlobalOp(
        env.project,
        compute.deletePublicAdvertisedPrefixes({
          project: env.project,
          publicAdvertisedPrefix: output.prefixName,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }),
  });
