import { ignoredCodes } from "./internal.ts";
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

const MAX_NAME_LENGTH = 63;
const DEFAULT_TYPE = "DEDICATED";
const DEFAULT_LINK_TYPE = "LINK_TYPE_ETHERNET_10G_LR";

export type InterconnectType =
  | compute.InterconnectInterconnectTypeEnum
  | (string & {});
export type InterconnectLinkType =
  | compute.InterconnectLinkTypeEnum
  | (string & {});
export type InterconnectMacsec = compute.InterconnectMacsec;
export type InterconnectApplicationAware =
  compute.InterconnectApplicationAwareInterconnect;

export type InterconnectProps = {
  /**
   * Interconnect name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the interconnect.
   */
  interconnectName?: string;
  /**
   * URL or name of the InterconnectLocation (for example
   * `iad-zone1-1`). Immutable — changing it replaces the interconnect.
   */
  location: string;
  /**
   * Dedicated physical interconnection or partner-managed. Immutable —
   * changing it replaces the interconnect.
   * @default "DEDICATED"
   */
  interconnectType?: InterconnectType;
  /**
   * Speed of each physical link in the bundle. Immutable — changing it
   * replaces the interconnect.
   * @default "LINK_TYPE_ETHERNET_10G_LR"
   */
  linkType?: InterconnectLinkType;
  /**
   * Target number of physical links in the bundle. Updated in place.
   * @default 1
   */
  requestedLinkCount?: number;
  /**
   * Customer name for the Letter of Authorization. Immutable — changing
   * it replaces the interconnect.
   */
  customerName?: string;
  /**
   * Optional description. Updated in place via `interconnects.patch`.
   */
  description?: string;
  /**
   * NOC contact email for operations notifications. Updated in place.
   */
  nocContactEmail?: string;
  /**
   * Administrative status. When `false`, the interconnect carries no
   * packets. Updated in place.
   * @default true
   */
  adminEnabled?: boolean;
  /**
   * Cross-Cloud Interconnect remote location URL. Immutable — changing
   * it replaces the interconnect.
   */
  remoteLocation?: string;
  /**
   * Enable MACsec on this interconnect. Updated in place.
   * @default false
   */
  macsecEnabled?: boolean;
  /**
   * MACsec pre-shared keys and configuration. Updated in place.
   */
  macsec?: InterconnectMacsec;
  /**
   * Features requested at create time (`IF_MACSEC`,
   * `IF_CROSS_SITE_NETWORK`). Immutable — changing them replaces the
   * interconnect.
   */
  requestedFeatures?: string[];
  /**
   * Enable application-aware interconnect. Updated in place.
   */
  aaiEnabled?: boolean;
  /**
   * Application-aware interconnect configuration. Updated in place.
   */
  applicationAwareInterconnect?: InterconnectApplicationAware;
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
};

export type Interconnect = Resource<
  "GCP.Compute.Interconnect",
  InterconnectProps,
  {
    /** Interconnect name. */
    interconnectName: string;
    /** Project id. */
    project: string;
    /** Interconnect location URL. */
    location: string | undefined;
    /** Interconnect type (`DEDICATED` or `PARTNER`). */
    interconnectType: string | undefined;
    /** Link type. */
    linkType: string | undefined;
    /** Requested number of physical links. */
    requestedLinkCount: number | undefined;
    /** Provisioned number of physical links. */
    provisionedLinkCount: number | undefined;
    /** Customer name on the LOA. */
    customerName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** NOC contact email. */
    nocContactEmail: string | undefined;
    /** Administrative status. */
    adminEnabled: boolean;
    /** Remote location URL for Cross-Cloud Interconnect. */
    remoteLocation: string | undefined;
    /** Whether MACsec is enabled. */
    macsecEnabled: boolean;
    /** MACsec configuration. */
    macsec: InterconnectMacsec | undefined;
    /** Requested features. */
    requestedFeatures: ReadonlyArray<string>;
    /** Available features. */
    availableFeatures: ReadonlyArray<string>;
    /** Application-aware interconnect enabled. */
    aaiEnabled: boolean;
    /** Application-aware interconnect config. */
    applicationAwareInterconnect: InterconnectApplicationAware | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Google reference id. */
    googleReferenceId: string | undefined;
    /** Operational status. */
    operationalStatus: string | undefined;
    /** Resource state. */
    state: string | undefined;
    /** Google-side ping IP. */
    googleIpAddress: string | undefined;
    /** Customer-side ping IP. */
    peerIpAddress: string | undefined;
    /** Attachment URLs using this interconnect. */
    interconnectAttachments: ReadonlyArray<string>;
    /** Interconnect group URLs. */
    interconnectGroups: ReadonlyArray<string>;
    /** Server-assigned numeric id. */
    interconnectId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Label fingerprint for `setLabels`. */
    labelFingerprint: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine Dedicated Interconnect.
 *
 * Dedicated Interconnect is a physical connection between your on-premises
 * network and Google's network at a colocation facility. Name, location,
 * interconnect type, link type, customer name, remote location, and
 * requested features are immutable. Description, admin status, link count,
 * NOC email, and MACsec update in place via `interconnects.patch`. Labels
 * are applied with `setLabels` after the interconnect exists.
 *
 * ### Creating an Interconnect
 * **Example:** Dedicated 10G interconnect
 * ```typescript
 * const interconnect = yield* GCP.Compute.Interconnect("OnPrem", {
 *   location: "iad-zone1-1",
 *   interconnectType: "DEDICATED",
 *   linkType: "LINK_TYPE_ETHERNET_10G_LR",
 *   requestedLinkCount: 1,
 *   customerName: "Example Corp",
 *   description: "prod interconnect",
 * });
 * ```
 *
 * **Example:** Named interconnect with labels
 * ```typescript
 * const interconnect = yield* GCP.Compute.Interconnect("OnPrem", {
 *   interconnectName: "app-ix",
 *   location: "iad-zone1-1",
 *   customerName: "Example Corp",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Interconnect = Resource<Interconnect>("GCP.Compute.Interconnect");

export class InterconnectNotResolved extends Data.TaggedError(
  "GCP.Compute.InterconnectNotResolved",
)<{
  interconnectName: string;
}> {}

export class InterconnectStillExists extends Data.TaggedError(
  "GCP.Compute.InterconnectStillExists",
)<{
  interconnectName: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `i${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "interconnect";
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

const locationUrl = (project: string, location: string) => {
  if (location.includes("/")) return location;
  return `projects/${project}/global/interconnectLocations/${location}`;
};

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_TYPE).toUpperCase();

const linkTypeOf = (value: string | undefined) => value ?? DEFAULT_LINK_TYPE;

const featuresKey = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])]
    .map((value) => value.toUpperCase())
    .sort()
    .join(",");

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (
  interconnect: compute.Interconnect,
  project: string,
): Interconnect["Attributes"] => ({
  interconnectName: interconnect.name ?? "",
  project,
  location: interconnect.location,
  interconnectType: interconnect.interconnectType,
  linkType: interconnect.linkType,
  requestedLinkCount: interconnect.requestedLinkCount,
  provisionedLinkCount: interconnect.provisionedLinkCount,
  customerName: interconnect.customerName,
  description: interconnect.description,
  nocContactEmail: interconnect.nocContactEmail,
  adminEnabled: interconnect.adminEnabled !== false,
  remoteLocation: interconnect.remoteLocation,
  macsecEnabled: interconnect.macsecEnabled === true,
  macsec: interconnect.macsec,
  requestedFeatures: interconnect.requestedFeatures ?? [],
  availableFeatures: interconnect.availableFeatures ?? [],
  aaiEnabled: interconnect.aaiEnabled === true,
  applicationAwareInterconnect: interconnect.applicationAwareInterconnect,
  labels: userLabels(interconnect.labels),
  googleReferenceId: interconnect.googleReferenceId,
  operationalStatus: interconnect.operationalStatus,
  state: interconnect.state,
  googleIpAddress: interconnect.googleIpAddress,
  peerIpAddress: interconnect.peerIpAddress,
  interconnectAttachments: interconnect.interconnectAttachments ?? [],
  interconnectGroups: interconnect.interconnectGroups ?? [],
  interconnectId: interconnect.id,
  selfLink: interconnect.selfLink,
  labelFingerprint: interconnect.labelFingerprint,
  creationTimestamp: interconnect.creationTimestamp,
  kind: interconnect.kind,
});

const getByName = (project: string, interconnect: string) =>
  compute
    .getInterconnects({ project, interconnect })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, interconnectName: string) =>
  getByName(project, interconnectName).pipe(
    Effect.flatMap((resource) =>
      resource !== undefined
        ? Effect.succeed(resource)
        : Effect.fail(new InterconnectNotResolved({ interconnectName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.InterconnectNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (project: string, interconnectName: string) =>
  getByName(project, interconnectName).pipe(
    Effect.flatMap((resource) =>
      resource === undefined
        ? Effect.void
        : Effect.fail(new InterconnectStillExists({ interconnectName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.InterconnectStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("GCP.Compute.InterconnectStillExists", () => Effect.void),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  interconnectName: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitGlobalOperation(project, operation, {
        ignore: ignoredCodes(options),
      }),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const InterconnectProvider = () =>
  Provider.succeed(Interconnect, {
    stables: [
      "interconnectName",
      "project",
      "interconnectId",
      "selfLink",
      "location",
      "interconnectType",
      "linkType",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.interconnectName ?? output?.interconnectName;
      const nextName = news.interconnectName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousLocation = lastSegment(olds?.location ?? output?.location);
      const nextLocation = lastSegment(news.location ?? previousLocation);
      const previousType = typeOf(
        olds?.interconnectType ?? output?.interconnectType,
      );
      const nextType = typeOf(news.interconnectType ?? previousType);
      const previousLink = linkTypeOf(olds?.linkType ?? output?.linkType);
      const nextLink = linkTypeOf(news.linkType ?? previousLink);
      const previousCustomer = olds?.customerName ?? output?.customerName ?? "";
      const nextCustomer = news.customerName ?? previousCustomer;
      const previousRemote = lastSegment(
        olds?.remoteLocation ?? output?.remoteLocation,
      );
      const nextRemote = lastSegment(news.remoteLocation ?? previousRemote);
      const previousFeatures = featuresKey(
        olds?.requestedFeatures ?? output?.requestedFeatures,
      );
      const nextFeatures = featuresKey(
        news.requestedFeatures ??
          olds?.requestedFeatures ??
          output?.requestedFeatures,
      );

      const immutableChanged =
        previousLocation !== nextLocation ||
        previousType !== nextType ||
        previousLink !== nextLink ||
        previousCustomer !== nextCustomer ||
        previousRemote !== nextRemote ||
        (news.requestedFeatures !== undefined &&
          previousFeatures !== nextFeatures);

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
      const interconnectName = yield* toName(
        id,
        olds?.interconnectName,
        output?.interconnectName,
      );
      const existing = yield* getByName(env.project, interconnectName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listInterconnects
          .items({
            project: env.project,
            filter: "labels.alchemy-id:*",
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.filter((item) =>
              Object.keys(item.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((item) => toAttrs(item, env.project)),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as Interconnect["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const interconnectName = yield* toName(
        id,
        news.interconnectName,
        output?.interconnectName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const location = locationUrl(env.project, news.location);
      const interconnectType = typeOf(news.interconnectType);
      const linkType = linkTypeOf(news.linkType);
      const requestedLinkCount = news.requestedLinkCount ?? 1;
      const adminEnabled = news.adminEnabled !== false;

      let current = yield* getByName(env.project, interconnectName);

      if (current === undefined) {
        yield* compute
          .insertInterconnects({
            project: env.project,
            body: {
              name: interconnectName,
              location,
              interconnectType,
              linkType,
              requestedLinkCount,
              customerName: news.customerName,
              description: news.description,
              nocContactEmail: news.nocContactEmail,
              adminEnabled,
              remoteLocation: news.remoteLocation,
              macsecEnabled: news.macsecEnabled,
              macsec: news.macsec,
              requestedFeatures: news.requestedFeatures,
              aaiEnabled: news.aaiEnabled,
              applicationAwareInterconnect: news.applicationAwareInterconnect,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(env.project, interconnectName);
      }

      const needsPatch =
        (current.description ?? "") !== (news.description ?? "") ||
        (current.nocContactEmail ?? "") !== (news.nocContactEmail ?? "") ||
        (current.adminEnabled !== false) !== adminEnabled ||
        (news.requestedLinkCount !== undefined &&
          (current.requestedLinkCount ?? 1) !== requestedLinkCount) ||
        (current.macsecEnabled === true) !== (news.macsecEnabled === true) ||
        (news.macsec !== undefined &&
          JSON.stringify(current.macsec ?? null) !==
            JSON.stringify(news.macsec ?? null)) ||
        (news.aaiEnabled !== undefined &&
          (current.aaiEnabled === true) !== news.aaiEnabled);

      if (needsPatch) {
        yield* runOp(
          env.project,
          interconnectName,
          compute.patchInterconnects({
            project: env.project,
            interconnect: interconnectName,
            body: {
              description: news.description,
              nocContactEmail: news.nocContactEmail,
              adminEnabled,
              requestedLinkCount,
              macsecEnabled: news.macsecEnabled,
              macsec: news.macsec,
              aaiEnabled: news.aaiEnabled,
              applicationAwareInterconnect: news.applicationAwareInterconnect,
            },
          }),
        );
        current = (yield* getByName(env.project, interconnectName)) ?? current;
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* Effect.gen(function* () {
          const latest =
            (yield* getByName(env.project, interconnectName)) ?? current;
          if (latest === undefined) {
            return yield* new InterconnectNotResolved({ interconnectName });
          }
          yield* runOp(
            env.project,
            interconnectName,
            compute.setLabelsInterconnects({
              project: env.project,
              resource: interconnectName,
              body: {
                labels: desiredLabels,
                labelFingerprint: latest.labelFingerprint,
              },
            }),
          );
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 5,
            schedule: Schedule.spaced("1 second"),
          }),
        );
        current = (yield* getByName(env.project, interconnectName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.interconnectName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      yield* compute
        .deleteInterconnects({
          project,
          interconnect: output.interconnectName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitGlobalOperation(project, operation, {
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
      yield* waitUntilGone(project, output.interconnectName);
    }),
  });
