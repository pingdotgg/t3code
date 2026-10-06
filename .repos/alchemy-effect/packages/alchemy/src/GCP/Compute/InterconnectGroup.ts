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
const DEFAULT_CAPABILITY = "NO_SLA";

export type InterconnectGroupIntent = compute.InterconnectGroupIntent;
export type InterconnectGroupInterconnectMap =
  compute.InterconnectGroupInterconnectMap;

export type InterconnectGroupProps = {
  /**
   * Group name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the group.
   */
  interconnectGroupName?: string;
  /**
   * Optional description. Interconnect groups have no labels field, so
   * Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * is stored in a `[alchemy …]` prefix for `list` / nuke. Updated in
   * place via `patch`.
   */
  description?: string;
  /**
   * Intended topology capability (`NO_SLA`, `PRODUCTION_NON_CRITICAL`,
   * `PRODUCTION_CRITICAL`). Required on create. Updated in place.
   * @default "NO_SLA"
   */
  intent?: InterconnectGroupIntent;
  /**
   * Member interconnects. Keys are arbitrary; values are `{ interconnect }`
   * URLs or names. Updated in place via `patch`.
   */
  interconnects?: InterconnectGroupInterconnectMap;
};

export type InterconnectGroup = Resource<
  "GCP.Compute.InterconnectGroup",
  InterconnectGroupProps,
  {
    /** Group name. */
    interconnectGroupName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** User intent. */
    intent: InterconnectGroupIntent | undefined;
    /** Member interconnects. */
    interconnects: InterconnectGroupInterconnectMap;
    /** Effective topology capability reported by GCP. */
    configured: compute.InterconnectGroupConfigured | undefined;
    /** Physical structure of member interconnects. */
    physicalStructure: compute.InterconnectGroupPhysicalStructure | undefined;
    /** Optimistic-locking etag. */
    etag: string | undefined;
    /** Server-assigned numeric id. */
    interconnectGroupId: string | undefined;
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
 * A global Compute Engine Interconnect group.
 *
 * Groups collect Dedicated Interconnects so GCP can report the topology
 * capability (SLA) they actually provide. Name is immutable. Description,
 * intent, and member interconnects update in place via
 * `interconnectGroups.patch`. Compute InterconnectGroup has no labels
 * field — Alchemy stamps ownership into the description so nuke can find
 * leaked groups.
 *
 * ### Creating an Interconnect Group
 * **Example:** Generated name, no SLA
 * ```typescript
 * const group = yield* GCP.Compute.InterconnectGroup("Bundle", {
 *   description: "dev interconnects",
 *   intent: { topologyCapability: "NO_SLA" },
 * });
 * ```
 *
 * **Example:** Named group with a member interconnect
 * ```typescript
 * const group = yield* GCP.Compute.InterconnectGroup("Bundle", {
 *   interconnectGroupName: "app-ix-group",
 *   intent: { topologyCapability: "PRODUCTION_NON_CRITICAL" },
 *   interconnects: {
 *     primary: { interconnect: interconnect.selfLink },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const InterconnectGroup = Resource<InterconnectGroup>(
  "GCP.Compute.InterconnectGroup",
);

export class InterconnectGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.InterconnectGroupNotResolved",
)<{
  interconnectGroupName: string;
}> {}

export class InterconnectGroupStillExists extends Data.TaggedError(
  "GCP.Compute.InterconnectGroupStillExists",
)<{
  interconnectGroupName: string;
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

const capabilityOf = (intent: InterconnectGroupIntent | undefined) =>
  (intent?.topologyCapability ?? DEFAULT_CAPABILITY).toUpperCase();

const interconnectUrl = (project: string, value: string) => {
  if (value.includes("/")) return value;
  return `projects/${project}/global/interconnects/${value}`;
};

const membersKey = (
  project: string,
  members: InterconnectGroupInterconnectMap | undefined,
) =>
  Object.entries(members ?? {})
    .map(([key, value]) => {
      const url = value?.interconnect;
      return `${key}:${url ? lastSegment(interconnectUrl(project, url)) : ""}`;
    })
    .sort()
    .join("|");

const toMembers = (
  project: string,
  members: InterconnectGroupInterconnectMap | undefined,
): InterconnectGroupInterconnectMap | undefined => {
  if (members === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(members).map(([key, value]) => [
      key,
      {
        interconnect: value?.interconnect
          ? interconnectUrl(project, value.interconnect)
          : value?.interconnect,
      },
    ]),
  );
};

const toAttrs = (
  group: compute.InterconnectGroup,
  project: string,
): InterconnectGroup["Attributes"] => {
  const parsed = parseDescription(group.description);
  return {
    interconnectGroupName: group.name ?? "",
    project,
    description: parsed.description,
    intent: group.intent,
    interconnects: group.interconnects ?? {},
    configured: group.configured,
    physicalStructure: group.physicalStructure,
    etag: group.etag,
    interconnectGroupId: group.id,
    selfLink: group.selfLink,
    creationTimestamp: group.creationTimestamp,
    kind: group.kind,
  };
};

const getByName = (project: string, interconnectGroup: string) =>
  compute
    .getInterconnectGroups({ project, interconnectGroup })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, interconnectGroupName: string) =>
  getByName(project, interconnectGroupName).pipe(
    Effect.flatMap((group) =>
      group !== undefined
        ? Effect.succeed(group)
        : Effect.fail(
            new InterconnectGroupNotResolved({ interconnectGroupName }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InterconnectGroupNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (project: string, interconnectGroupName: string) =>
  getByName(project, interconnectGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(
            new InterconnectGroupStillExists({ interconnectGroupName }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InterconnectGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.Compute.InterconnectGroupStillExists",
      () => Effect.void,
    ),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  interconnectGroupName: string,
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

export const InterconnectGroupProvider = () =>
  Provider.succeed(InterconnectGroup, {
    stables: [
      "interconnectGroupName",
      "project",
      "interconnectGroupId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.interconnectGroupName ?? output?.interconnectGroupName;
      const nextName = news.interconnectGroupName ?? previousName;
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
      const interconnectGroupName = yield* toName(
        id,
        olds?.interconnectGroupName,
        output?.interconnectGroupName,
      );
      const existing = yield* getByName(env.project, interconnectGroupName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listInterconnectGroups
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
              Effect.succeed([] as InterconnectGroup["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const interconnectGroupName = yield* toName(
        id,
        news.interconnectGroupName,
        output?.interconnectGroupName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const intent: InterconnectGroupIntent = {
        topologyCapability: capabilityOf(news.intent ?? output?.intent),
      };
      const interconnects = toMembers(env.project, news.interconnects);

      let current = yield* getByName(env.project, interconnectGroupName);

      if (current === undefined) {
        yield* compute
          .insertInterconnectGroups({
            project: env.project,
            body: {
              name: interconnectGroupName,
              description: desiredDescription,
              intent,
              interconnects,
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
        current = yield* awaitResource(env.project, interconnectGroupName);
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const intentChanged =
        capabilityOf(current.intent) !== capabilityOf(intent);
      const membersChanged =
        news.interconnects !== undefined &&
        membersKey(env.project, current.interconnects) !==
          membersKey(env.project, interconnects);

      if (descriptionChanged || intentChanged || membersChanged) {
        yield* runOp(
          env.project,
          interconnectGroupName,
          compute.patchInterconnectGroups({
            project: env.project,
            interconnectGroup: interconnectGroupName,
            updateMask: "description,intent,interconnects",
            body: {
              etag: current.etag,
              description: desiredDescription,
              intent,
              interconnects:
                news.interconnects !== undefined
                  ? interconnects
                  : current.interconnects,
            },
          }),
        );
        current =
          (yield* getByName(env.project, interconnectGroupName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.interconnectGroupName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      yield* compute
        .deleteInterconnectGroups({
          project,
          interconnectGroup: output.interconnectGroupName,
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
      yield* waitUntilGone(project, output.interconnectGroupName);
    }),
  });
