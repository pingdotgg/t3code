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

const DEFAULT_CONNECTION_PREFERENCE = "ACCEPT_AUTOMATIC";
const MAX_NAME_LENGTH = 63;

export type NetworkAttachmentConnectionPreference =
  | compute.NetworkAttachmentConnectionPreferenceEnum
  | (string & {});
export type NetworkAttachmentConnectedEndpoint =
  compute.NetworkAttachmentConnectedEndpoint;

export type NetworkAttachmentProps = {
  /**
   * Attachment name (RFC1035, 1-63 characters). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the attachment.
   */
  networkAttachmentName?: string;
  /**
   * Region the attachment lives in. Immutable — changing it replaces the
   * attachment. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Subnet URLs or names the consumer provides for producer endpoints.
   * All subnets must be in the same VPC. Required. Updated in place via
   * `patch`.
   */
  subnetworks: string[];
  /**
   * How producer connections are admitted. `ACCEPT_AUTOMATIC` always
   * accepts; `ACCEPT_MANUAL` uses the accept and reject lists.
   * Immutable — GCP rejects `patch` of this field, so changing it
   * replaces the attachment.
   * @default "ACCEPT_AUTOMATIC"
   */
  connectionPreference?: NetworkAttachmentConnectionPreference;
  /**
   * Optional description. Compute network attachments have no labels
   * field, so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) is stored in a `[alchemy …]` prefix for `list` / nuke.
   * Updated in place via `patch`.
   */
  description?: string;
  /**
   * Producer projects allowed to connect (id or number). Used with
   * `ACCEPT_MANUAL`. Updated in place via `patch`.
   */
  producerAcceptLists?: string[];
  /**
   * Producer projects that must not connect. Updated in place via
   * `patch`.
   */
  producerRejectLists?: string[];
};

export type NetworkAttachment = Resource<
  "GCP.Compute.NetworkAttachment",
  NetworkAttachmentProps,
  {
    /** Attachment name. */
    networkAttachmentName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Parent VPC network URL. */
    network: string | undefined;
    /** Consumer subnet URLs. */
    subnetworks: ReadonlyArray<string>;
    /** Connection preference. */
    connectionPreference: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Accepted producer projects. */
    producerAcceptLists: ReadonlyArray<string>;
    /** Rejected producer projects. */
    producerRejectLists: ReadonlyArray<string>;
    /** Connected producer endpoints. */
    connectionEndpoints: ReadonlyArray<NetworkAttachmentConnectedEndpoint>;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-assigned numeric id. */
    networkAttachmentId: string | undefined;
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
 * A regional Compute Engine Private Service Connect network attachment.
 *
 * A network attachment lets a producer VPC initiate connections into a
 * consumer VPC through a PSC interface. It lists consumer subnets and
 * admits producers either automatically or via accept/reject lists.
 * Compute NetworkAttachment has no labels field — Alchemy ownership is
 * stored in the description so nuke can find leaked attachments.
 *
 * ### Creating a Network Attachment
 * **Example:** Generated name, automatic accept
 * ```typescript
 * const attachment = yield* GCP.Compute.NetworkAttachment("Consumer", {
 *   region: "us-central1",
 *   subnetworks: [subnet.selfLink],
 *   connectionPreference: "ACCEPT_AUTOMATIC",
 * });
 * ```
 *
 * **Example:** Manual admission
 * ```typescript
 * const attachment = yield* GCP.Compute.NetworkAttachment("Consumer", {
 *   networkAttachmentName: "app-na",
 *   subnetworks: [subnet.selfLink],
 *   connectionPreference: "ACCEPT_MANUAL",
 *   producerAcceptLists: ["my-producer-project"],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const NetworkAttachment = Resource<NetworkAttachment>(
  "GCP.Compute.NetworkAttachment",
);

export class NetworkAttachmentNotResolved extends Data.TaggedError(
  "GCP.Compute.NetworkAttachmentNotResolved",
)<{
  networkAttachmentName: string;
  region: string;
}> {}

export class NetworkAttachmentStillExists extends Data.TaggedError(
  "GCP.Compute.NetworkAttachmentStillExists",
)<{
  networkAttachmentName: string;
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
  if (!/^[a-z]/.test(next)) next = `n${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "attachment";
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

const preferenceOf = (value: string | undefined) =>
  value && value.length > 0 ? value : DEFAULT_CONNECTION_PREFERENCE;

const toSubnetworkUrl = (project: string, region: string, value: string) => {
  if (value.includes("/")) return value;
  return `projects/${project}/regions/${region}/subnetworks/${value}`;
};

const refsKey = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])]
    .map((value) => lastSegment(value))
    .filter((value) => value.length > 0)
    .sort()
    .join(",");

const toAttrs = (
  attachment: compute.NetworkAttachment,
  project: string,
  fallbackName?: string,
): NetworkAttachment["Attributes"] => {
  const parsed = parseDescription(attachment.description);
  const region = lastSegment(attachment.region).toLowerCase();
  const networkAttachmentName =
    attachment.name ||
    lastSegment(attachment.selfLink) ||
    lastSegment(attachment.selfLinkWithId) ||
    fallbackName ||
    "";
  const selfLink =
    attachment.selfLink && attachment.selfLink.length > 0
      ? attachment.selfLink
      : networkAttachmentName.length > 0
        ? `https://www.googleapis.com/compute/v1/projects/${project}/regions/${region}/networkAttachments/${networkAttachmentName}`
        : undefined;
  return {
    networkAttachmentName,
    project,
    region,
    network: attachment.network,
    subnetworks: attachment.subnetworks ?? [],
    connectionPreference: attachment.connectionPreference,
    description: parsed.description,
    producerAcceptLists: attachment.producerAcceptLists ?? [],
    producerRejectLists: attachment.producerRejectLists ?? [],
    connectionEndpoints: attachment.connectionEndpoints ?? [],
    fingerprint: attachment.fingerprint,
    networkAttachmentId: attachment.id,
    selfLink,
    selfLinkWithId: attachment.selfLinkWithId ?? selfLink,
    creationTimestamp: attachment.creationTimestamp,
    kind: attachment.kind,
  };
};

const getByName = (
  project: string,
  region: string,
  networkAttachment: string,
) =>
  compute
    .getNetworkAttachments({ project, region, networkAttachment })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  region: string,
  networkAttachmentName: string,
) =>
  getByName(project, region, networkAttachmentName).pipe(
    Effect.flatMap((attachment) =>
      attachment !== undefined
        ? Effect.succeed(attachment)
        : Effect.fail(
            new NetworkAttachmentNotResolved({
              networkAttachmentName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.NetworkAttachmentNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  networkAttachmentName: string,
) =>
  getByName(project, region, networkAttachmentName).pipe(
    Effect.flatMap((attachment) =>
      attachment === undefined
        ? Effect.void
        : Effect.fail(
            new NetworkAttachmentStillExists({ networkAttachmentName }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.NetworkAttachmentStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag(
      "GCP.Compute.NetworkAttachmentStillExists",
      () => Effect.void,
    ),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  region: string,
  networkAttachmentName: string,
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

export const NetworkAttachmentProvider = () =>
  Provider.succeed(NetworkAttachment, {
    stables: [
      "networkAttachmentName",
      "project",
      "region",
      "networkAttachmentId",
      "selfLink",
      "selfLinkWithId",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds?.networkAttachmentName ?? output?.networkAttachmentName;
      const nextName = news.networkAttachmentName ?? previousName;
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
      const previousPreference = preferenceOf(
        olds?.connectionPreference ?? output?.connectionPreference,
      );
      const nextPreference = preferenceOf(news.connectionPreference);
      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        previousRegion !== nextRegion ||
        previousPreference !== nextPreference
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkAttachmentName = yield* toName(
        id,
        olds?.networkAttachmentName,
        output?.networkAttachmentName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        networkAttachmentName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, networkAttachmentName);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListNetworkAttachments
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.networkAttachments ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkAttachmentName = yield* toName(
        id,
        news.networkAttachmentName,
        output?.networkAttachmentName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const subnetworks = news.subnetworks.map((subnet) =>
        toSubnetworkUrl(env.project, region, subnet),
      );
      const connectionPreference = preferenceOf(news.connectionPreference);

      let current = yield* getByName(
        env.project,
        region,
        networkAttachmentName,
      );

      if (current === undefined) {
        yield* compute
          .insertNetworkAttachments({
            project: env.project,
            region,
            body: {
              name: networkAttachmentName,
              description: desiredDescription,
              subnetworks,
              connectionPreference,
              producerAcceptLists: news.producerAcceptLists,
              producerRejectLists: news.producerRejectLists,
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
          networkAttachmentName,
        );
      }

      const needsPatch =
        (current.description ?? "") !== desiredDescription ||
        refsKey(current.subnetworks) !== refsKey(subnetworks) ||
        (news.producerAcceptLists !== undefined &&
          refsKey(current.producerAcceptLists) !==
            refsKey(news.producerAcceptLists)) ||
        (news.producerRejectLists !== undefined &&
          refsKey(current.producerRejectLists) !==
            refsKey(news.producerRejectLists));

      if (needsPatch) {
        const latest =
          (yield* getByName(env.project, region, networkAttachmentName)) ??
          current;
        yield* runOp(
          env.project,
          region,
          networkAttachmentName,
          compute.patchNetworkAttachments({
            project: env.project,
            region,
            networkAttachment: networkAttachmentName,
            body: {
              fingerprint: latest.fingerprint,
              description: desiredDescription,
              subnetworks,
              producerAcceptLists:
                news.producerAcceptLists ?? current.producerAcceptLists,
              producerRejectLists:
                news.producerRejectLists ?? current.producerRejectLists,
            },
          }),
        );
        current =
          (yield* getByName(env.project, region, networkAttachmentName)) ??
          current;
      }

      return toAttrs(current, env.project, networkAttachmentName);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.networkAttachmentName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      yield* compute
        .deleteNetworkAttachments({
          project,
          region,
          networkAttachment: output.networkAttachmentName,
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
      yield* waitUntilGone(project, region, output.networkAttachmentName);
    }),
  });
