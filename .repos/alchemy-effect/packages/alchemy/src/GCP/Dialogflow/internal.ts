import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

/**
 * Dialogflow's "All other requests per minute" quota is shared by the whole
 * project and distilled's default backoff gives up within ~30s, before the
 * minute window resets. Lifecycles are idempotent, so re-run them once the
 * window has rolled over.
 */
export const retryQuota = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "TooManyRequests",
      times: 6,
      schedule: Schedule.spaced("20 seconds"),
    }),
  );

export const DEFAULT_LOCATION = "global";
export const DEFAULT_SESSION = "alchemy";
export const LIST_LOCATIONS = ["global", "us-central1"] as const;

/** Locations scanned by `list`: the fixed set plus the stack region. */
export const listLocations = (region: string): string[] => [
  ...new Set<string>([...LIST_LOCATIONS, region]),
];
export const MAX_ID_LENGTH = 63;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_ROUTE_GROUP_DISPLAY_NAME_LENGTH = 30;
export const MAX_DESCRIPTION_LENGTH = 8000;
export const MAX_SESSION_ID_LENGTH = 36;

export class DialogflowOperationFailed extends Data.TaggedError(
  "GCP.Dialogflow.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class DialogflowOperationPending extends Data.TaggedError(
  "GCP.Dialogflow.OperationPending",
)<{
  operation: string;
}> {}

export class DialogflowStillExists extends Data.TaggedError(
  "GCP.Dialogflow.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationOf = (name: string, fallback = DEFAULT_LOCATION) => {
  const parts = name.split("/");
  const index = parts.indexOf("locations");
  return index >= 0 ? (parts[index + 1] ?? fallback) : fallback;
};

export const projectOf = (name: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("projects");
  return index >= 0 ? (parts[index + 1] ?? "") : "";
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const collectionParent = (
  name: string,
  collection:
    | "agents"
    | "playbooks"
    | "tools"
    | "sessions"
    | "entityTypes"
    | "flows"
    | "environments"
    | "webhooks"
    | "transitionRouteGroups",
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf(collection);
  if (index < 0 || parts[index + 1] === undefined) return parentOf(name);
  return parts.slice(0, index + 2).join("/");
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const expandAgent = (
  value: string,
  project: string,
  location: string,
) =>
  value.includes("/agents/")
    ? value
    : `${locationParent(project, location)}/agents/${value}`;

export const expandName = (
  value: string,
  project: string,
  location: string,
  collection: "agents" | "flows" | "environments" | "entityTypes",
  parent?: string,
) => {
  if (value.includes("/")) return value;
  if (parent !== undefined) return `${parent}/${collection}/${value}`;
  return `${locationParent(project, location)}/${collection}/${value}`;
};

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const agentsAt = parts.lastIndexOf("agents");
  const flowsAt = parts.lastIndexOf("flows");
  const environmentsAt = parts.lastIndexOf("environments");
  const sessionsAt = parts.lastIndexOf("sessions");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    agentId: agentsAt >= 0 && parts[agentsAt + 1] ? parts[agentsAt + 1]! : "",
    agent:
      agentsAt >= 0 ? parts.slice(0, agentsAt + 2).join("/") : parentOf(name),
    flowId: flowsAt >= 0 && parts[flowsAt + 1] ? parts[flowsAt + 1]! : "",
    flow: flowsAt >= 0 ? parts.slice(0, flowsAt + 2).join("/") : "",
    environmentId:
      environmentsAt >= 0 && parts[environmentsAt + 1]
        ? parts[environmentsAt + 1]!
        : "",
    environment:
      environmentsAt >= 0 ? parts.slice(0, environmentsAt + 2).join("/") : "",
    sessionId:
      sessionsAt >= 0 && parts[sessionsAt + 1] ? parts[sessionsAt + 1]! : "",
    session: sessionsAt >= 0 ? parts.slice(0, sessionsAt + 2).join("/") : "",
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `d${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const markerOf = (
  labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const compactMarkerOf = (stack: string, stage: string, id: string) =>
  `[alc ${stack} ${stage} ${id}]`;

const shrinkMarker = (
  labels: Record<string, string>,
  maxLength: number,
  build: (stack: string, stage: string, id: string) => string,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = build(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = build(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

const fitMarker = (labels: Record<string, string>, maxLength: number) =>
  shrinkMarker(labels, maxLength, (stack, stage, id) =>
    markerOf(labels, stack, stage, id),
  );

const fitCompactMarker = (labels: Record<string, string>, maxLength: number) =>
  shrinkMarker(labels, maxLength, compactMarkerOf);

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = fitMarker(labels, MAX_DESCRIPTION_LENGTH);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  // Reserve room for the user's text so the marker shrinks instead of the
  // text being cut off (a compact marker keeps all three ownership fields).
  const reserved = trimmed
    ? Math.min(trimmed.length + 1, Math.max(0, maxLength - 16))
    : 0;
  const room = maxLength - reserved;
  const marker =
    room < 54 ? fitCompactMarker(labels, room) : fitMarker(labels, room);
  if (!trimmed) return marker;
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (text?.startsWith("[alc ")) {
    const end = text.indexOf("]");
    if (end < 0) return { labels: {}, text };
    const parts = text.slice("[alc ".length, end).trim().split(/\s+/);
    const labels: Record<string, string> = {};
    if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0]!;
    if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1]!;
    if (parts[2]) labels[alchemyLabelKeys.id] = parts[2]!;
    const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
    return { labels, text: rest.length > 0 ? rest : undefined };
  }
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const internalLabels = (id: string) => createInternalLabels(id);

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const ownershipText = (resource: {
  displayName?: string;
  description?: string;
}) =>
  hasOwnershipMarker(resource.description)
    ? resource.description
    : resource.displayName;

export const getByName = <A, E>(
  name: string,
  get: (name: string) => Effect.Effect<A, E, never>,
) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : get(name).pipe(
        Effect.catchTag("NotFound" as never, () => Effect.succeed(undefined)),
      );

export const listPages = <A, E, R>(
  pages: Stream.Stream<{ items: readonly A[] }, E, R>,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.items)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound" as never, () => Effect.succeed([] as A[])),
  );

const collect = <Page, Item, E extends { _tag: string }, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchIf(
      (error): error is E => error._tag === "NotFound",
      () => Effect.succeed([] as Item[]),
    ),
  );

export const listAgents = (project: string, location?: string) =>
  Effect.gen(function* () {
    const locations = location
      ? [normalizeLocation(location)]
      : listLocations((yield* GcpEnvironment.current).region);
    return yield* Effect.forEach(
      locations,
      (loc) =>
        collect(
          dialogflow.listProjectsLocationsAgents.pages({
            parent: locationParent(project, loc),
            pageSize: 100,
          }),
          (page) => page.agents,
        ),
      { concurrency: 2 },
    ).pipe(Effect.map((groups) => groups.flat()));
  });

export const namedAgents = (project: string) =>
  listAgents(project).pipe(
    Effect.map((agents) =>
      agents.filter(
        (
          agent,
        ): agent is dialogflow.GoogleCloudDialogflowCxV3Agent & {
          name: string;
        } => typeof agent.name === "string" && agent.name.length > 0,
      ),
    ),
  );

export const listEntityTypes = (agent: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsEntityTypes.pages({
      parent: agent,
      pageSize: 100,
    }),
    (page) => page.entityTypes,
  );

export const listEnvironments = (agent: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsEnvironments.pages({
      parent: agent,
      pageSize: 100,
    }),
    (page) => page.environments,
  );

export const listExperiments = (environment: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsEnvironmentsExperiments.pages({
      parent: environment,
      pageSize: 100,
    }),
    (page) => page.experiments,
  );

export const listSessionEntityTypes = (session: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsEnvironmentsSessionsEntityTypes.pages(
      {
        parent: session,
        pageSize: 100,
      },
    ),
    (page) => page.sessionEntityTypes,
  );

export const listFlows = (agent: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsFlows.pages({
      parent: agent,
      pageSize: 100,
    }),
    (page) => page.flows,
  );

export const listPagesAt = (flow: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsFlowsPages.pages({
      parent: flow,
      pageSize: 100,
    }),
    (page) => page.pages,
  );

export const listTransitionRouteGroups = (flow: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsFlowsTransitionRouteGroups.pages({
      parent: flow,
      pageSize: 100,
    }),
    (page) => page.transitionRouteGroups,
  );

export const listAgentTransitionRouteGroups = (agent: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsTransitionRouteGroups.pages({
      parent: agent,
      pageSize: 100,
    }),
    (page) => page.transitionRouteGroups,
  );

export const listWebhooks = (agent: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsWebhooks.pages({
      parent: agent,
      pageSize: 100,
    }),
    (page) => page.webhooks,
  );

export const listVersions = (flow: string) =>
  collect(
    dialogflow.listProjectsLocationsAgentsFlowsVersions.pages({
      parent: flow,
      pageSize: 100,
    }),
    (page) => page.versions,
  );

export const listSecuritySettings = (parent: string) =>
  collect(
    dialogflow.listProjectsLocationsSecuritySettings.pages({
      parent,
      pageSize: 100,
    }),
    (page) => page.securitySettings,
  );

export const resourceNameFromOperation = (
  operation: dialogflow.GoogleLongrunningOperation,
): string | undefined => {
  const response = operation.response;
  const responseName = response?.name;
  if (typeof responseName === "string" && responseName.length > 0) {
    return responseName;
  }
  const metadata = operation.metadata;
  const target = metadata?.target;
  if (typeof target === "string" && target.length > 0) {
    return target;
  }
  const metadataName = metadata?.name;
  if (typeof metadataName === "string" && metadataName.length > 0) {
    return metadataName;
  }
  return undefined;
};

/** Wait for an operation through the shared GCP waiter. */
export const waitForOperation = (
  operation: dialogflow.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      dialogflow.getProjectsLocationsOperations({ name }).pipe(
        Effect.catchTag("NotFound", (error) =>
          options?.notFoundOk === true
            ? Effect.succeed<dialogflow.GoogleLongrunningOperation>({
                name,
                done: true,
              })
            : Effect.fail(error),
        ),
      ),
    { budget: "10 minutes" },
  ).pipe(
    // ALREADY_EXISTS (6): a concurrent create won the race. NOT_FOUND (5)
    // is success for a delete.
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        ((options?.alreadyExistsOk !== false && error.code === 6) ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    // Re-read the finished operation for its typed response and metadata.
    Effect.flatMap(() =>
      operation.name === undefined || operation.name.length === 0
        ? Effect.succeed(operation)
        : dialogflow
            .getProjectsLocationsOperations({ name: operation.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(operation))),
    ),
  );

export class DialogflowNotYetReadable extends Data.TaggedError(
  "GCP.Dialogflow.NotYetReadable",
)<{ name: string }> {}

/** Some Dialogflow creates are not readable for a few seconds afterwards. */
export const waitUntilReadable = <A, E extends { readonly _tag: string }, R>(
  name: string,
  get: (name: string) => Effect.Effect<A | undefined, E, R>,
) =>
  get(name).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.fail(new DialogflowNotYetReadable({ name }))
        : Effect.succeed(value),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dialogflow.NotYetReadable",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  name: string,
  get: (name: string) => Effect.Effect<A | undefined, E, R>,
) =>
  get(name).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Effect.fail(new DialogflowStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dialogflow.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );
