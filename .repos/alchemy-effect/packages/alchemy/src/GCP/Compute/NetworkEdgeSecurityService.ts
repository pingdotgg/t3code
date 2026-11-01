import { ignoredCodes } from "./internal.ts";
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
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;

export type NetworkEdgeSecurityServiceProps = {
  /**
   * Service name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the service.
   */
  networkEdgeSecurityServiceName?: string;
  /**
   * Region the service lives in. Immutable — changing it replaces the
   * service. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Network edge security services have no labels
   * field, so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) is stored in a `[alchemy …]` prefix for `list` / nuke.
   * Updated in place via `patch`.
   */
  description?: string;
  /**
   * Cloud Armor network security policy URL attached to this service.
   * Updated in place via `patch`.
   */
  securityPolicy?: string;
};

export type NetworkEdgeSecurityService = Resource<
  "GCP.Compute.NetworkEdgeSecurityService",
  NetworkEdgeSecurityServiceProps,
  {
    /** Service name. */
    networkEdgeSecurityServiceName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Attached Cloud Armor network security policy URL. */
    securityPolicy: string | undefined;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-assigned numeric id. */
    networkEdgeSecurityServiceId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Self-link including the numeric id. */
    selfLinkWithId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine network edge security service.
 *
 * Network edge security services attach a Cloud Armor network (L3/L4)
 * security policy to a region. Name and region are immutable. Description
 * and `securityPolicy` update in place via
 * `networkEdgeSecurityServices.patch`. Compute NetworkEdgeSecurityService
 * has no labels field — Alchemy stamps ownership into the description so
 * nuke can find leaked services.
 *
 * ### Creating a Network Edge Security Service
 * **Example:** Generated name
 * ```typescript
 * const ness = yield* GCP.Compute.NetworkEdgeSecurityService("EdgeArmor", {
 *   region: "us-central1",
 *   description: "regional network armor",
 * });
 * ```
 *
 * **Example:** Attach a network security policy
 * ```typescript
 * const ness = yield* GCP.Compute.NetworkEdgeSecurityService("EdgeArmor", {
 *   networkEdgeSecurityServiceName: "app-ness",
 *   securityPolicy: policy.selfLink,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const NetworkEdgeSecurityService = Resource<NetworkEdgeSecurityService>(
  "GCP.Compute.NetworkEdgeSecurityService",
);

export class NetworkEdgeSecurityServiceNotResolved extends Data.TaggedError(
  "GCP.Compute.NetworkEdgeSecurityServiceNotResolved",
)<{
  networkEdgeSecurityServiceName: string;
  region: string;
}> {}

export class NetworkEdgeSecurityServiceStillExists extends Data.TaggedError(
  "GCP.Compute.NetworkEdgeSecurityServiceStillExists",
)<{
  networkEdgeSecurityServiceName: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `e${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "ness";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
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
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toAttrs = (
  service: compute.NetworkEdgeSecurityService,
  project: string,
): NetworkEdgeSecurityService["Attributes"] => {
  const parsed = parseDescription(service.description);
  return {
    networkEdgeSecurityServiceName: service.name ?? "",
    project,
    region: lastSegment(service.region).toLowerCase(),
    description: parsed.description,
    securityPolicy: service.securityPolicy,
    fingerprint: service.fingerprint,
    networkEdgeSecurityServiceId: service.id,
    selfLink: service.selfLink,
    selfLinkWithId: service.selfLinkWithId,
    creationTimestamp: service.creationTimestamp,
    kind: service.kind,
  };
};

const getByName = (
  project: string,
  region: string,
  networkEdgeSecurityService: string,
) =>
  compute
    .getNetworkEdgeSecurityServices({
      project,
      region,
      networkEdgeSecurityService,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  region: string,
  networkEdgeSecurityServiceName: string,
) =>
  getByName(project, region, networkEdgeSecurityServiceName).pipe(
    Effect.flatMap((service) =>
      service !== undefined
        ? Effect.succeed(service)
        : Effect.fail(
            new NetworkEdgeSecurityServiceNotResolved({
              networkEdgeSecurityServiceName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.NetworkEdgeSecurityServiceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  networkEdgeSecurityServiceName: string,
) =>
  getByName(project, region, networkEdgeSecurityServiceName).pipe(
    Effect.flatMap((service) =>
      service === undefined
        ? Effect.void
        : Effect.fail(
            new NetworkEdgeSecurityServiceStillExists({
              networkEdgeSecurityServiceName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.NetworkEdgeSecurityServiceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag(
      "GCP.Compute.NetworkEdgeSecurityServiceStillExists",
      () => Effect.void,
    ),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  region: string,
  networkEdgeSecurityServiceName: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitRegionOperation(project, region, operation, {
        ignore: ignoredCodes(options),
      }),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const NetworkEdgeSecurityServiceProvider = () =>
  Provider.succeed(NetworkEdgeSecurityService, {
    stables: [
      "networkEdgeSecurityServiceName",
      "project",
      "region",
      "networkEdgeSecurityServiceId",
      "selfLink",
      "selfLinkWithId",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds?.networkEdgeSecurityServiceName ??
        output?.networkEdgeSecurityServiceName;
      const nextName = news.networkEdgeSecurityServiceName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? previousRegion,
        env.region,
      );
      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (previousRegion !== nextRegion) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkEdgeSecurityServiceName = yield* toName(
        id,
        olds?.networkEdgeSecurityServiceName,
        output?.networkEdgeSecurityServiceName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        networkEdgeSecurityServiceName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListNetworkEdgeSecurityServices
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.networkEdgeSecurityServices ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkEdgeSecurityServiceName = yield* toName(
        id,
        news.networkEdgeSecurityServiceName,
        output?.networkEdgeSecurityServiceName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(
        env.project,
        region,
        networkEdgeSecurityServiceName,
      );

      if (current === undefined) {
        yield* compute
          .insertNetworkEdgeSecurityServices({
            project: env.project,
            region,
            body: {
              name: networkEdgeSecurityServiceName,
              description: desiredDescription,
              securityPolicy: news.securityPolicy,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(
          env.project,
          region,
          networkEdgeSecurityServiceName,
        );
      }

      const needsPatch =
        (current.description ?? "") !== desiredDescription ||
        (news.securityPolicy !== undefined &&
          lastSegment(current.securityPolicy) !==
            lastSegment(news.securityPolicy));

      if (needsPatch) {
        const latest =
          (yield* getByName(
            env.project,
            region,
            networkEdgeSecurityServiceName,
          )) ?? current;
        yield* runOp(
          env.project,
          region,
          networkEdgeSecurityServiceName,
          compute.patchNetworkEdgeSecurityServices({
            project: env.project,
            region,
            networkEdgeSecurityService: networkEdgeSecurityServiceName,
            body: {
              fingerprint: latest.fingerprint,
              description: desiredDescription,
              securityPolicy: news.securityPolicy ?? current.securityPolicy,
            },
          }),
        );
        current =
          (yield* getByName(
            env.project,
            region,
            networkEdgeSecurityServiceName,
          )) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.networkEdgeSecurityServiceName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      yield* compute
        .deleteNetworkEdgeSecurityServices({
          project,
          region,
          networkEdgeSecurityService: output.networkEdgeSecurityServiceName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(
        project,
        region,
        output.networkEdgeSecurityServiceName,
      );
    }),
  });
