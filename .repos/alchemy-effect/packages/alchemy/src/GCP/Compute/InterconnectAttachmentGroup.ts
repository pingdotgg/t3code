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
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;
const DEFAULT_SLA = "NO_SLA";

export type InterconnectAttachmentGroupIntent =
  compute.InterconnectAttachmentGroupIntent;
export type InterconnectAttachmentGroupAttachmentMap =
  compute.InterconnectAttachmentGroupAttachmentMap;

export type InterconnectAttachmentGroupProps = {
  /**
   * Group name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the group.
   */
  interconnectAttachmentGroupName?: string;
  /**
   * Optional description. Attachment groups have no labels field, so
   * Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * is stored in a `[alchemy …]` prefix for `list` / nuke. Updated in
   * place via `patch`.
   */
  description?: string;
  /**
   * Intended availability SLA (`NO_SLA`, `PRODUCTION_NON_CRITICAL`,
   * `PRODUCTION_CRITICAL`). Required on create. Updated in place.
   * @default "NO_SLA"
   */
  intent?: InterconnectAttachmentGroupIntent;
  /**
   * Member VLAN attachments. Keys are arbitrary; values are
   * `{ attachment }` URLs. Updated in place via `patch`.
   */
  attachments?: InterconnectAttachmentGroupAttachmentMap;
  /**
   * Optional InterconnectGroup URL that groups these attachments'
   * interconnects. Only set when directed by Google Support.
   */
  interconnectGroup?: string;
};

export type InterconnectAttachmentGroup = Resource<
  "GCP.Compute.InterconnectAttachmentGroup",
  InterconnectAttachmentGroupProps,
  {
    /** Group name. */
    interconnectAttachmentGroupName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** User intent. */
    intent: InterconnectAttachmentGroupIntent | undefined;
    /** Member VLAN attachments. */
    attachments: InterconnectAttachmentGroupAttachmentMap;
    /** Linked InterconnectGroup URL, if any. */
    interconnectGroup: string | undefined;
    /** Effective SLA reported by GCP. */
    configured: compute.InterconnectAttachmentGroupConfigured | undefined;
    /** Logical structure of member attachments. */
    logicalStructure:
      | compute.InterconnectAttachmentGroupLogicalStructure
      | undefined;
    /** Optimistic-locking etag. */
    etag: string | undefined;
    /** Server-assigned numeric id. */
    interconnectAttachmentGroupId: string | undefined;
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
 * A global Compute Engine Interconnect attachment group.
 *
 * Groups collect VLAN attachments so GCP can report the availability SLA
 * they actually provide. Name is immutable. Description, intent, member
 * attachments, and the optional InterconnectGroup URL update in place via
 * `interconnectAttachmentGroups.patch`. Compute InterconnectAttachmentGroup
 * has no labels field — Alchemy stamps ownership into the description so
 * nuke can find leaked groups.
 *
 * ### Creating an Attachment Group
 * **Example:** Generated name, no SLA
 * ```typescript
 * const group = yield* GCP.Compute.InterconnectAttachmentGroup("Vlans", {
 *   description: "dev vlan attachments",
 *   intent: { availabilitySla: "NO_SLA" },
 * });
 * ```
 *
 * **Example:** Named group with a member attachment
 * ```typescript
 * const group = yield* GCP.Compute.InterconnectAttachmentGroup("Vlans", {
 *   interconnectAttachmentGroupName: "app-vlan-group",
 *   intent: { availabilitySla: "PRODUCTION_NON_CRITICAL" },
 *   attachments: {
 *     primary: { attachment: attachment.selfLink },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const InterconnectAttachmentGroup =
  Resource<InterconnectAttachmentGroup>(
    "GCP.Compute.InterconnectAttachmentGroup",
  );

export class InterconnectAttachmentGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.InterconnectAttachmentGroupNotResolved",
)<{
  interconnectAttachmentGroupName: string;
}> {}

export class InterconnectAttachmentGroupStillExists extends Data.TaggedError(
  "GCP.Compute.InterconnectAttachmentGroupStillExists",
)<{
  interconnectAttachmentGroupName: string;
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
  if (!/^[a-z]/.test(next)) next = `g${next}`;
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

const slaOf = (intent: InterconnectAttachmentGroupIntent | undefined) =>
  (intent?.availabilitySla ?? DEFAULT_SLA).toUpperCase();

const membersKey = (
  members: InterconnectAttachmentGroupAttachmentMap | undefined,
) =>
  Object.entries(members ?? {})
    .map(([key, value]) => `${key}:${lastSegment(value?.attachment)}`)
    .sort()
    .join("|");

const toAttrs = (
  group: compute.InterconnectAttachmentGroup,
  project: string,
): InterconnectAttachmentGroup["Attributes"] => {
  const parsed = parseDescription(group.description);
  return {
    interconnectAttachmentGroupName: group.name ?? "",
    project,
    description: parsed.description,
    intent: group.intent,
    attachments: group.attachments ?? {},
    interconnectGroup: group.interconnectGroup,
    configured: group.configured,
    logicalStructure: group.logicalStructure,
    etag: group.etag,
    interconnectAttachmentGroupId: group.id,
    selfLink: group.selfLink,
    creationTimestamp: group.creationTimestamp,
    kind: group.kind,
  };
};

const getByName = (project: string, interconnectAttachmentGroup: string) =>
  compute
    .getInterconnectAttachmentGroups({
      project,
      interconnectAttachmentGroup,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  interconnectAttachmentGroupName: string,
) =>
  getByName(project, interconnectAttachmentGroupName).pipe(
    Effect.flatMap((group) =>
      group !== undefined
        ? Effect.succeed(group)
        : Effect.fail(
            new InterconnectAttachmentGroupNotResolved({
              interconnectAttachmentGroupName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InterconnectAttachmentGroupNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  interconnectAttachmentGroupName: string,
) =>
  getByName(project, interconnectAttachmentGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(
            new InterconnectAttachmentGroupStillExists({
              interconnectAttachmentGroupName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InterconnectAttachmentGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.Compute.InterconnectAttachmentGroupStillExists",
      () => Effect.void,
    ),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  interconnectAttachmentGroupName: string,
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

export const InterconnectAttachmentGroupProvider = () =>
  Provider.succeed(InterconnectAttachmentGroup, {
    stables: [
      "interconnectAttachmentGroupName",
      "project",
      "interconnectAttachmentGroupId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.interconnectAttachmentGroupName ??
        output?.interconnectAttachmentGroupName;
      const nextName = news.interconnectAttachmentGroupName ?? previousName;
      if (
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const interconnectAttachmentGroupName = yield* toName(
        id,
        olds?.interconnectAttachmentGroupName,
        output?.interconnectAttachmentGroupName,
      );
      const existing = yield* getByName(
        env.project,
        interconnectAttachmentGroupName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listInterconnectAttachmentGroups
          .items({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.filter((group) => hasOwnershipMarker(group.description)),
            Stream.map((group) => toAttrs(group, env.project)),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as InterconnectAttachmentGroup["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const interconnectAttachmentGroupName = yield* toName(
        id,
        news.interconnectAttachmentGroupName,
        output?.interconnectAttachmentGroupName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const intent: InterconnectAttachmentGroupIntent = {
        availabilitySla: slaOf(news.intent ?? output?.intent),
      };

      let current = yield* getByName(
        env.project,
        interconnectAttachmentGroupName,
      );

      if (current === undefined) {
        yield* compute
          .insertInterconnectAttachmentGroups({
            project: env.project,
            body: {
              name: interconnectAttachmentGroupName,
              description: desiredDescription,
              intent,
              attachments: news.attachments,
              interconnectGroup: news.interconnectGroup,
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
        current = yield* awaitResource(
          env.project,
          interconnectAttachmentGroupName,
        );
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const intentChanged = slaOf(current.intent) !== slaOf(intent);
      const membersChanged =
        news.attachments !== undefined &&
        membersKey(current.attachments) !== membersKey(news.attachments);
      const groupChanged =
        news.interconnectGroup !== undefined &&
        lastSegment(current.interconnectGroup) !==
          lastSegment(news.interconnectGroup);

      if (
        descriptionChanged ||
        intentChanged ||
        membersChanged ||
        groupChanged
      ) {
        yield* runOp(
          env.project,
          interconnectAttachmentGroupName,
          compute.patchInterconnectAttachmentGroups({
            project: env.project,
            interconnectAttachmentGroup: interconnectAttachmentGroupName,
            updateMask: "description,intent,attachments,interconnectGroup",
            body: {
              etag: current.etag,
              description: desiredDescription,
              intent,
              attachments:
                news.attachments !== undefined
                  ? news.attachments
                  : current.attachments,
              interconnectGroup:
                news.interconnectGroup ?? current.interconnectGroup,
            },
          }),
        );
        current =
          (yield* getByName(env.project, interconnectAttachmentGroupName)) ??
          current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.interconnectAttachmentGroupName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      yield* compute
        .deleteInterconnectAttachmentGroups({
          project,
          interconnectAttachmentGroup: output.interconnectAttachmentGroupName,
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
      yield* waitUntilGone(project, output.interconnectAttachmentGroupName);
    }),
  });
