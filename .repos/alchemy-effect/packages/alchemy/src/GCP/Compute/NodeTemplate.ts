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
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;

export type NodeTemplateCpuOvercommitType =
  | compute.NodeTemplateCpuOvercommitTypeEnum
  | (string & {});
export type NodeTemplateLocalDisk = compute.LocalDisk;
export type NodeTemplateAccelerator = compute.AcceleratorConfig;
export type NodeTemplateNodeTypeFlexibility =
  compute.NodeTemplateNodeTypeFlexibility;
export type NodeTemplateServerBinding = compute.ServerBinding;

export type NodeTemplateProps = {
  /**
   * Template name (RFC1035, 1-63 characters). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the template.
   */
  nodeTemplateName?: string;
  /**
   * Region the template lives in. Immutable — changing it replaces the
   * template. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Node templates have no labels field, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * in a `[alchemy …]` prefix for `list` / nuke. Description is set at
   * create time — changing it replaces the template.
   */
  description?: string;
  /**
   * Sole-tenant node type (for example `n2-node-80-640`). Mutually
   * exclusive with `nodeTypeFlexibility`. Immutable — changing it
   * replaces the template.
   */
  nodeType?: string;
  /**
   * Flexible vCPU / memory / local-SSD requirements. Mutually exclusive
   * with `nodeType`. Immutable — changing it replaces the template.
   */
  nodeTypeFlexibility?: NodeTemplateNodeTypeFlexibility;
  /**
   * CPU overcommit (`NONE` or `ENABLED`). Immutable — changing it
   * replaces the template.
   */
  cpuOvercommitType?: NodeTemplateCpuOvercommitType;
  /**
   * Node affinity labels used when scheduling instances. Immutable —
   * changing them replaces the template.
   */
  nodeAffinityLabels?: Record<string, string>;
  /**
   * Local disks attached to each node. Immutable — changing them
   * replaces the template.
   */
  disks?: NodeTemplateLocalDisk[];
  /**
   * Accelerators attached to each node. Immutable — changing them
   * replaces the template.
   */
  accelerators?: NodeTemplateAccelerator[];
  /**
   * Physical-server binding. Immutable — changing it replaces the
   * template.
   */
  serverBinding?: NodeTemplateServerBinding;
};

export type NodeTemplate = Resource<
  "GCP.Compute.NodeTemplate",
  NodeTemplateProps,
  {
    /** Template name. */
    nodeTemplateName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Sole-tenant node type. */
    nodeType: string | undefined;
    /** Flexible node-type requirements. */
    nodeTypeFlexibility: NodeTemplateNodeTypeFlexibility | undefined;
    /** CPU overcommit. */
    cpuOvercommitType: string | undefined;
    /** Node affinity labels. */
    nodeAffinityLabels: Record<string, string>;
    /** Local disks. */
    disks: ReadonlyArray<NodeTemplateLocalDisk>;
    /** Accelerators. */
    accelerators: ReadonlyArray<NodeTemplateAccelerator>;
    /** Server binding. */
    serverBinding: NodeTemplateServerBinding | undefined;
    /** Template status. */
    status: string | undefined;
    /** Status message. */
    statusMessage: string | undefined;
    /** Server-assigned numeric id. */
    nodeTemplateId: string | undefined;
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
 * A regional Compute Engine sole-tenant node template.
 *
 * Node templates define the properties of sole-tenant nodes created in a
 * node group (node type, CPU overcommit, affinity labels, local disks).
 * There is no in-place update API — changing any property replaces the
 * template. Compute NodeTemplate has no labels field — Alchemy stamps
 * ownership into the description so nuke can find leaked templates.
 *
 * ### Creating a Node Template
 * **Example:** Generated name with a node type
 * ```typescript
 * const template = yield* GCP.Compute.NodeTemplate("SoleTenant", {
 *   region: "us-central1",
 *   nodeType: "n2-node-80-640",
 *   description: "prod sole tenant",
 * });
 * ```
 *
 * **Example:** Flexible node type
 * ```typescript
 * const template = yield* GCP.Compute.NodeTemplate("SoleTenant", {
 *   nodeTypeFlexibility: { cpus: "80", memory: "640GB" },
 *   cpuOvercommitType: "ENABLED",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const NodeTemplate = Resource<NodeTemplate>("GCP.Compute.NodeTemplate");

export class NodeTemplateNotResolved extends Data.TaggedError(
  "GCP.Compute.NodeTemplateNotResolved",
)<{
  nodeTemplateName: string;
  region: string;
}> {}

export class NodeTemplateStillExists extends Data.TaggedError(
  "GCP.Compute.NodeTemplateStillExists",
)<{
  nodeTemplateName: string;
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
  if (!/^[a-z]/.test(next)) next = `t${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "template";
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

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const toAttrs = (
  template: compute.NodeTemplate,
  project: string,
): NodeTemplate["Attributes"] => {
  const parsed = parseDescription(template.description);
  return {
    nodeTemplateName: template.name ?? "",
    project,
    region: lastSegment(template.region).toLowerCase(),
    description: parsed.description,
    nodeType: template.nodeType,
    nodeTypeFlexibility: template.nodeTypeFlexibility,
    cpuOvercommitType: template.cpuOvercommitType,
    nodeAffinityLabels: tagRecord(template.nodeAffinityLabels),
    disks: template.disks ?? [],
    accelerators: template.accelerators ?? [],
    serverBinding: template.serverBinding,
    status: template.status,
    statusMessage: template.statusMessage,
    nodeTemplateId: template.id,
    selfLink: template.selfLink,
    creationTimestamp: template.creationTimestamp,
    kind: template.kind,
  };
};

const getByName = (project: string, region: string, nodeTemplate: string) =>
  compute
    .getNodeTemplates({ project, region, nodeTemplate })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  region: string,
  nodeTemplateName: string,
) =>
  getByName(project, region, nodeTemplateName).pipe(
    Effect.flatMap((template) =>
      template !== undefined
        ? Effect.succeed(template)
        : Effect.fail(
            new NodeTemplateNotResolved({ nodeTemplateName, region }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.NodeTemplateNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  nodeTemplateName: string,
) =>
  getByName(project, region, nodeTemplateName).pipe(
    Effect.flatMap((template) =>
      template === undefined
        ? Effect.void
        : Effect.fail(new NodeTemplateStillExists({ nodeTemplateName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.NodeTemplateStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("GCP.Compute.NodeTemplateStillExists", () => Effect.void),
  );

export const NodeTemplateProvider = () =>
  Provider.succeed(NodeTemplate, {
    stables: [
      "nodeTemplateName",
      "project",
      "region",
      "nodeTemplateId",
      "selfLink",
      "nodeType",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.nodeTemplateName ?? output?.nodeTemplateName;
      const nextName = news.nodeTemplateName ?? previousName;
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

      const previousType = olds?.nodeType ?? output?.nodeType ?? "";
      const nextType = news.nodeType ?? previousType;
      const previousOvercommit =
        olds?.cpuOvercommitType ?? output?.cpuOvercommitType;
      const nextOvercommit = news.cpuOvercommitType ?? previousOvercommit;
      const previousBinding = olds?.serverBinding ?? output?.serverBinding;
      const nextBinding = news.serverBinding ?? previousBinding;
      const previousFlex =
        olds?.nodeTypeFlexibility ?? output?.nodeTypeFlexibility;
      const nextFlex = news.nodeTypeFlexibility ?? previousFlex;
      const previousAffinity =
        olds?.nodeAffinityLabels ?? output?.nodeAffinityLabels ?? {};
      const nextAffinity = news.nodeAffinityLabels ?? previousAffinity;
      const previousDisks = olds?.disks ?? output?.disks ?? [];
      const nextDisks = news.disks ?? previousDisks;
      const previousAccel = olds?.accelerators ?? output?.accelerators ?? [];
      const nextAccel = news.accelerators ?? previousAccel;
      const previousDescription =
        olds?.description ?? output?.description ?? "";
      const nextDescription = news.description ?? previousDescription;

      const immutableChanged =
        previousType !== nextType ||
        previousOvercommit !== nextOvercommit ||
        !sameJson(previousBinding, nextBinding) ||
        !sameJson(previousFlex, nextFlex) ||
        !sameJson(previousAffinity, nextAffinity) ||
        !sameJson(previousDisks, nextDisks) ||
        !sameJson(previousAccel, nextAccel) ||
        previousDescription !== nextDescription;

      if (nameChanged || previousRegion !== nextRegion) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const nodeTemplateName = yield* toName(
        id,
        olds?.nodeTemplateName,
        output?.nodeTemplateName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, nodeTemplateName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListNodeTemplates
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.nodeTemplates ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const nodeTemplateName = yield* toName(
        id,
        news.nodeTemplateName,
        output?.nodeTemplateName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(env.project, region, nodeTemplateName);

      if (current === undefined) {
        yield* compute
          .insertNodeTemplates({
            project: env.project,
            region,
            body: {
              name: nodeTemplateName,
              description: desiredDescription,
              nodeType: news.nodeType,
              nodeTypeFlexibility: news.nodeTypeFlexibility,
              cpuOvercommitType: news.cpuOvercommitType,
              nodeAffinityLabels: news.nodeAffinityLabels,
              disks: news.disks,
              accelerators: news.accelerators,
              serverBinding: news.serverBinding,
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
        current = yield* awaitResource(env.project, region, nodeTemplateName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.nodeTemplateName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      yield* compute
        .deleteNodeTemplates({
          project,
          region,
          nodeTemplate: output.nodeTemplateName,
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
      yield* waitUntilGone(project, region, output.nodeTemplateName);
    }),
  });
