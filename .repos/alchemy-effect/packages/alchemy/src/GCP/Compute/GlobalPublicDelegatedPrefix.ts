import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type GlobalPublicDelegatedPrefixProps = {
  /**
   * Prefix name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the prefix.
   */
  prefixName?: string;
  /**
   * Optional description. Public delegated prefixes have no labels field —
   * Alchemy ownership is stored in a `[alchemy …]` prefix for `list` /
   * nuke.
   */
  description?: string;
  /**
   * Parent Public Advertised Prefix or Public Delegated Prefix URL.
   * Immutable — changing it replaces the prefix.
   */
  parentPrefix: string;
  /**
   * IP range in CIDR format allocated from the parent. Immutable —
   * changing it replaces the prefix.
   */
  ipCidrRange: string;
  /**
   * IPv6 allocation mode (`DELEGATION`,
   * `EXTERNAL_IPV6_FORWARDING_RULE_CREATION`, …). Immutable — changing
   * it replaces the prefix.
   */
  mode?: compute.PublicDelegatedPrefixModeEnum | (string & {});
  /**
   * Allocatable prefix length for IPv6 prefixes that are not in
   * `DELEGATION` mode.
   */
  allocatablePrefixLength?: number;
  /**
   * Whether this prefix is a live-migration prefix.
   */
  isLiveMigration?: boolean;
};

export type GlobalPublicDelegatedPrefix = Resource<
  "GCP.Compute.GlobalPublicDelegatedPrefix",
  GlobalPublicDelegatedPrefixProps,
  {
    /** Prefix name. */
    prefixName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Parent prefix URL. */
    parentPrefix: string | undefined;
    /** Allocated CIDR. */
    ipCidrRange: string | undefined;
    /** Allocation mode. */
    mode: string | undefined;
    /** Allocatable prefix length. */
    allocatablePrefixLength: number | undefined;
    /** Live-migration flag. */
    isLiveMigration: boolean | undefined;
    /** Server-reported status. */
    status: string | undefined;
    /** IPv6 access type inherited from the parent. */
    ipv6AccessType: string | undefined;
    /** Server-assigned numeric id. */
    prefixId: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine public delegated prefix (BYOIP).
 *
 * Delegates a CIDR from a Public Advertised Prefix so addresses and
 * sub-prefixes can be created. Creating one requires a parent advertised
 * prefix (Bring Your Own IP). Name, parent, CIDR, and mode replace the
 * resource; description updates in place via patch. Compute has no labels
 * field, so Alchemy stamps ownership into the description.
 *
 * ### Creating a Global Public Delegated Prefix
 * **Example:** Delegate a /24 from a PAP
 * ```typescript
 * const prefix = yield* GCP.Compute.GlobalPublicDelegatedPrefix("byoip", {
 *   parentPrefix:
 *     "projects/my-project/global/publicAdvertisedPrefixes/edge",
 *   ipCidrRange: "203.0.113.0/24",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const GlobalPublicDelegatedPrefix =
  Resource<GlobalPublicDelegatedPrefix>(
    "GCP.Compute.GlobalPublicDelegatedPrefix",
  );

export class GlobalPublicDelegatedPrefixNotResolved extends Data.TaggedError(
  "GCP.Compute.GlobalPublicDelegatedPrefixNotResolved",
)<{
  prefixName: string;
}> {}

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `p${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "publicdelegatedprefix";
};

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || value;
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const toAttrs = (
  prefix: compute.PublicDelegatedPrefix,
  project: string,
): GlobalPublicDelegatedPrefix["Attributes"] => {
  const parsed = parseDescription(prefix.description);
  return {
    prefixName: prefix.name ?? prefix.id ?? "",
    project,
    description: parsed.description,
    parentPrefix: prefix.parentPrefix,
    ipCidrRange: prefix.ipCidrRange,
    mode: prefix.mode,
    allocatablePrefixLength: prefix.allocatablePrefixLength,
    isLiveMigration: prefix.isLiveMigration,
    status: prefix.status,
    ipv6AccessType: prefix.ipv6AccessType,
    prefixId: prefix.id,
    selfLink: prefix.selfLink,
    creationTimestamp: prefix.creationTimestamp,
  };
};

const getByName = (project: string, publicDelegatedPrefix: string) =>
  compute
    .getGlobalPublicDelegatedPrefixes({ project, publicDelegatedPrefix })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, prefixName: string) =>
  getByName(project, prefixName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (item) => item !== undefined,
      times: 8,
    }),
  );

export const GlobalPublicDelegatedPrefixProvider = () =>
  Provider.succeed(GlobalPublicDelegatedPrefix, {
    stables: [
      "prefixName",
      "project",
      "parentPrefix",
      "ipCidrRange",
      "mode",
      "prefixId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.prefixName ?? output?.prefixName;
      const nextName = news.prefixName;
      const previousParent = lastSegment(
        olds?.parentPrefix ?? output?.parentPrefix,
      );
      const nextParent = lastSegment(news.parentPrefix);
      const previousRange = olds?.ipCidrRange ?? output?.ipCidrRange ?? "";
      const nextRange = news.ipCidrRange;
      const previousMode = olds?.mode ?? output?.mode ?? "";
      const nextMode = news.mode ?? previousMode;
      if (
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        (nextParent.length > 0 &&
          previousParent.length > 0 &&
          previousParent !== nextParent) ||
        (nextRange.length > 0 &&
          previousRange.length > 0 &&
          previousRange !== nextRange) ||
        (news.mode !== undefined && previousMode !== nextMode)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            nextName !== undefined &&
            previousName === nextName,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const prefixName = yield* toName(
        id,
        olds?.prefixName,
        output?.prefixName,
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
        return yield* compute.listGlobalPublicDelegatedPrefixes
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((prefix) => {
              const { labels } = parseDescription(prefix.description);
              return Object.keys(labels).some((key) =>
                key.startsWith("alchemy-"),
              );
            }),
            Stream.map((prefix) => toAttrs(prefix, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const prefixName = yield* toName(id, news.prefixName, output?.prefixName);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);

      let current = yield* getByName(env.project, prefixName);

      if (current === undefined) {
        yield* compute
          .insertGlobalPublicDelegatedPrefixes({
            project: env.project,
            body: {
              name: prefixName,
              description,
              parentPrefix: news.parentPrefix,
              ipCidrRange: news.ipCidrRange,
              mode: news.mode,
              allocatablePrefixLength: news.allocatablePrefixLength,
              isLiveMigration: news.isLiveMigration,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* awaitResource(env.project, prefixName);
      }

      if (current === undefined) {
        return yield* new GlobalPublicDelegatedPrefixNotResolved({
          prefixName,
        });
      }

      if ((current.description ?? "") !== description) {
        yield* compute
          .patchGlobalPublicDelegatedPrefixes({
            project: env.project,
            publicDelegatedPrefix: prefixName,
            body: {
              description,
              fingerprint: current.fingerprint,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, prefixName);
        if (current === undefined) {
          return yield* new GlobalPublicDelegatedPrefixNotResolved({
            prefixName,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteGlobalPublicDelegatedPrefixes({
          project: env.project,
          publicDelegatedPrefix: output.prefixName,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
