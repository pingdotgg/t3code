import { ignoredCodes } from "./internal.ts";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitZoneOperation } from "./operations.ts";
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

const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_MAINTENANCE_POLICY = "DEFAULT";
const MAX_NAME_LENGTH = 63;

export type NodeGroupMaintenancePolicy =
  | compute.NodeGroupMaintenancePolicyEnum
  | (string & {});
export type NodeGroupMaintenanceInterval =
  | compute.NodeGroupMaintenanceIntervalEnum
  | (string & {});
export type NodeGroupAutoscalingPolicy = compute.NodeGroupAutoscalingPolicy;
export type NodeGroupMaintenanceWindow = compute.NodeGroupMaintenanceWindow;
export type NodeGroupShareSettings = compute.ShareSettings;

export type NodeGroupProps = {
  /**
   * Group name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the group.
   */
  nodeGroupName?: string;
  /**
   * Zone the group lives in. Immutable — changing it replaces the group.
   * `US-CENTRAL1-A` is accepted and normalized to `us-central1-a`.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Node template URL or name used to create nodes. Required. Updated in
   * place via `setNodeTemplate`.
   */
  nodeTemplate: string;
  /**
   * Initial number of nodes. Required on create; later size changes use
   * `addNodes` / `deleteNodes` and are not applied from this field.
   * @default 0
   */
  initialNodeCount?: number;
  /**
   * Optional description. Node groups have no labels field, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * in a `[alchemy …]` prefix for `list` / nuke. Updated in place via
   * `patch`.
   */
  description?: string;
  /**
   * How instances are handled during host maintenance.
   * @default "DEFAULT"
   */
  maintenancePolicy?: NodeGroupMaintenancePolicy;
  /**
   * Daily maintenance window start time (`00:00`, `04:00`, …).
   */
  maintenanceWindow?: NodeGroupMaintenanceWindow;
  /**
   * Planned-maintenance frequency (`AS_NEEDED` or `RECURRENT`).
   */
  maintenanceInterval?: NodeGroupMaintenanceInterval;
  /**
   * Autoscaling policy. Updated in place via `patch`.
   */
  autoscalingPolicy?: NodeGroupAutoscalingPolicy;
  /**
   * Share settings for this node group. Updated in place via `patch`.
   */
  shareSettings?: NodeGroupShareSettings;
};

export type NodeGroup = Resource<
  "GCP.Compute.NodeGroup",
  NodeGroupProps,
  {
    /** Group name. */
    nodeGroupName: string;
    /** Project id. */
    project: string;
    /** Zone short name (`us-central1-a`). */
    zone: string;
    /** Node template URL. */
    nodeTemplate: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Number of nodes currently in the group. */
    size: number | undefined;
    /** Maintenance policy. */
    maintenancePolicy: string | undefined;
    /** Maintenance window. */
    maintenanceWindow: NodeGroupMaintenanceWindow | undefined;
    /** Maintenance interval. */
    maintenanceInterval: string | undefined;
    /** Autoscaling policy. */
    autoscalingPolicy: NodeGroupAutoscalingPolicy | undefined;
    /** Share settings. */
    shareSettings: NodeGroupShareSettings | undefined;
    /** Group status. */
    status: string | undefined;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-assigned numeric id. */
    nodeGroupId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine sole-tenant node group.
 *
 * Node groups allocate dedicated physical servers from a node template.
 * Name and zone are immutable. Description, maintenance policy, window,
 * interval, autoscaling, and share settings update in place via
 * `nodeGroups.patch`. The node template is swapped with
 * `setNodeTemplate`. Compute NodeGroup has no labels field — Alchemy
 * stamps ownership into the description so nuke can find leaked groups.
 *
 * ### Creating a Node Group
 * **Example:** Generated name from a template
 * ```typescript
 * const group = yield* GCP.Compute.NodeGroup("SoleTenant", {
 *   zone: "us-central1-a",
 *   nodeTemplate: template.selfLink,
 *   initialNodeCount: 1,
 *   description: "prod sole tenant",
 * });
 * ```
 *
 * **Example:** Autoscaled group
 * ```typescript
 * const group = yield* GCP.Compute.NodeGroup("SoleTenant", {
 *   nodeTemplate: template.nodeTemplateName,
 *   initialNodeCount: 0,
 *   autoscalingPolicy: { mode: "ON", minNodes: 0, maxNodes: 3 },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const NodeGroup = Resource<NodeGroup>("GCP.Compute.NodeGroup");

export class NodeGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.NodeGroupNotResolved",
)<{
  nodeGroupName: string;
  zone: string;
}> {}

export class NodeGroupStillExists extends Data.TaggedError(
  "GCP.Compute.NodeGroupStillExists",
)<{
  nodeGroupName: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeZone = (zone: string | undefined) =>
  lastSegment(zone ?? DEFAULT_ZONE).toLowerCase();

const regionOfZone = (zone: string) => {
  const parts = zone.split("-");
  return parts.length >= 3 ? parts.slice(0, 2).join("-") : zone;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `n${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "group";
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

const maintenanceOf = (value: string | undefined) =>
  (value ?? DEFAULT_MAINTENANCE_POLICY).toUpperCase();

const nodeTemplateUrl = (project: string, zone: string, value: string) => {
  if (value.includes("/")) return value;
  return `projects/${project}/regions/${regionOfZone(zone)}/nodeTemplates/${value}`;
};

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const toAttrs = (
  group: compute.NodeGroup,
  project: string,
): NodeGroup["Attributes"] => {
  const parsed = parseDescription(group.description);
  return {
    nodeGroupName: group.name ?? "",
    project,
    zone: normalizeZone(group.zone),
    nodeTemplate: group.nodeTemplate,
    description: parsed.description,
    size: group.size,
    maintenancePolicy: group.maintenancePolicy,
    maintenanceWindow: group.maintenanceWindow,
    maintenanceInterval: group.maintenanceInterval,
    autoscalingPolicy: group.autoscalingPolicy,
    shareSettings: group.shareSettings,
    status: group.status,
    fingerprint: group.fingerprint,
    nodeGroupId: group.id,
    selfLink: group.selfLink,
    creationTimestamp: group.creationTimestamp,
    kind: group.kind,
  };
};

const getByName = (project: string, zone: string, nodeGroup: string) =>
  compute
    .getNodeGroups({ project, zone, nodeGroup })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, zone: string, nodeGroupName: string) =>
  getByName(project, zone, nodeGroupName).pipe(
    Effect.flatMap((group) =>
      group !== undefined
        ? Effect.succeed(group)
        : Effect.fail(new NodeGroupNotResolved({ nodeGroupName, zone })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.NodeGroupNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (project: string, zone: string, nodeGroupName: string) =>
  getByName(project, zone, nodeGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(new NodeGroupStillExists({ nodeGroupName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.NodeGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("GCP.Compute.NodeGroupStillExists", () => Effect.void),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  zone: string,
  nodeGroupName: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitZoneOperation(project, zone, operation, {
        ignore: ignoredCodes(options),
      }),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const NodeGroupProvider = () =>
  Provider.succeed(NodeGroup, {
    stables: [
      "nodeGroupName",
      "project",
      "zone",
      "nodeGroupId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.nodeGroupName ?? output?.nodeGroupName;
      const nextName = news.nodeGroupName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const previousZone = normalizeZone(olds?.zone ?? output?.zone);
      const nextZone = normalizeZone(news.zone ?? previousZone);
      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (previousZone !== nextZone) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const nodeGroupName = yield* toName(
        id,
        olds?.nodeGroupName,
        output?.nodeGroupName,
      );
      const zone = normalizeZone(olds?.zone ?? output?.zone);
      const existing = yield* getByName(env.project, zone, nodeGroupName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListNodeGroups
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.nodeGroups ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const nodeGroupName = yield* toName(
        id,
        news.nodeGroupName,
        output?.nodeGroupName,
      );
      const zone = normalizeZone(news.zone ?? output?.zone);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const nodeTemplate = nodeTemplateUrl(
        env.project,
        zone,
        news.nodeTemplate,
      );
      const maintenancePolicy = maintenanceOf(news.maintenancePolicy);
      const initialNodeCount = news.initialNodeCount ?? 0;

      let current = yield* getByName(env.project, zone, nodeGroupName);

      if (current === undefined) {
        yield* compute
          .insertNodeGroups({
            project: env.project,
            zone,
            initialNodeCount,
            body: {
              name: nodeGroupName,
              description: desiredDescription,
              nodeTemplate,
              maintenancePolicy,
              maintenanceWindow: news.maintenanceWindow,
              maintenanceInterval: news.maintenanceInterval,
              autoscalingPolicy: news.autoscalingPolicy,
              shareSettings: news.shareSettings,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitZoneOperation(env.project, zone, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(env.project, zone, nodeGroupName);
      }

      if (lastSegment(current.nodeTemplate) !== lastSegment(nodeTemplate)) {
        yield* runOp(
          env.project,
          zone,
          nodeGroupName,
          compute.setNodeTemplateNodeGroups({
            project: env.project,
            zone,
            nodeGroup: nodeGroupName,
            body: { nodeTemplate },
          }),
        );
        current =
          (yield* getByName(env.project, zone, nodeGroupName)) ?? current;
      }

      const needsPatch =
        (current.description ?? "") !== desiredDescription ||
        maintenanceOf(current.maintenancePolicy) !== maintenancePolicy ||
        (news.maintenanceInterval !== undefined &&
          (current.maintenanceInterval ?? "") !== news.maintenanceInterval) ||
        (news.maintenanceWindow !== undefined &&
          !sameJson(current.maintenanceWindow, news.maintenanceWindow)) ||
        (news.autoscalingPolicy !== undefined &&
          !sameJson(current.autoscalingPolicy, news.autoscalingPolicy)) ||
        (news.shareSettings !== undefined &&
          !sameJson(current.shareSettings, news.shareSettings));

      if (needsPatch) {
        const latest =
          (yield* getByName(env.project, zone, nodeGroupName)) ?? current;
        yield* runOp(
          env.project,
          zone,
          nodeGroupName,
          compute.patchNodeGroups({
            project: env.project,
            zone,
            nodeGroup: nodeGroupName,
            body: {
              fingerprint: latest.fingerprint,
              description: desiredDescription,
              maintenancePolicy,
              maintenanceWindow:
                news.maintenanceWindow ?? current.maintenanceWindow,
              maintenanceInterval:
                news.maintenanceInterval ?? current.maintenanceInterval,
              autoscalingPolicy:
                news.autoscalingPolicy ?? current.autoscalingPolicy,
              shareSettings: news.shareSettings ?? current.shareSettings,
            },
          }),
        );
        current =
          (yield* getByName(env.project, zone, nodeGroupName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.nodeGroupName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const zone = normalizeZone(output.zone);
      yield* compute
        .deleteNodeGroups({
          project,
          zone,
          nodeGroup: output.nodeGroupName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitZoneOperation(project, zone, operation, {
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
      yield* waitUntilGone(project, zone, output.nodeGroupName);
    }),
  });
