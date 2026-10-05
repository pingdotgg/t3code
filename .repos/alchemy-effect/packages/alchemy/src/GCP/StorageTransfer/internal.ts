import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_AGENT_POOL_ID = 128;
export const MAX_AGENT_POOL_DISPLAY_NAME = 127;
export const MAX_JOB_ID = 115;
export const MAX_JOB_DESCRIPTION = 1024;
export const JOB_NAME_PREFIX = "transferJobs/";
export const DEFAULT_JOB_STATUS = "ENABLED";
export const DEFAULT_AGENT_POOL = "transfer_service_default";

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.StorageTransfer.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.StorageTransfer.ResourceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.StorageTransfer.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const agentPoolName = (project: string, agentPoolId: string) =>
  `projects/${project}/agentPools/${agentPoolId}`;

export const transferJobName = (jobId: string) =>
  jobId.startsWith(JOB_NAME_PREFIX) ? jobId : `${JOB_NAME_PREFIX}${jobId}`;

export const jobIdOf = (name: string) =>
  name.startsWith(JOB_NAME_PREFIX)
    ? name.slice(JOB_NAME_PREFIX.length)
    : lastSegment(name);

export const agentPoolIdOf = (name: string) => lastSegment(name);

const startsWithLetter = (value: string) => /^[a-z]/.test(value);

const endsAlnum = (value: string) => /[a-z0-9]$/.test(value);

export const sanitizeAgentPoolId = (value: string) => {
  let next = lastSegment(value)
    .toLowerCase()
    .replace(/[^a-z0-9-._~]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (next.startsWith("goog")) next = `x${next}`;
  if (!startsWithLetter(next)) next = `p${next}`;
  next = next.slice(0, MAX_AGENT_POOL_ID);
  if (next.length > 1 && !endsAlnum(next)) {
    next = `${next.slice(0, MAX_AGENT_POOL_ID - 1)}0`;
  }
  return next.length > 0 ? next : "pool";
};

export const sanitizeJobId = (value: string) => {
  let next = jobIdOf(value)
    .replace(/[^A-Za-z0-9-._~]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (next.toUpperCase().startsWith("OPI")) next = `x${next}`;
  next = next.slice(0, MAX_JOB_ID);
  if (next.length === 0) next = "job";
  if (!endsAlnum(next.toLowerCase())) {
    next = `${next.slice(0, MAX_JOB_ID - 1)}0`;
  }
  return next;
};

export const toAgentPoolId = (
  id: string,
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return sanitizeAgentPoolId(explicit);
    if (existing !== undefined) return existing;
    return sanitizeAgentPoolId(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
        forbiddenPrefixes: ["goog"],
      }),
    );
  });

export const toJobId = (
  id: string,
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return sanitizeJobId(explicit);
    if (existing !== undefined) return existing;
    return sanitizeJobId(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
        forbiddenPrefixes: ["opi"],
      }),
    );
  });

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
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
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, Math.max(0, maxLength));
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_JOB_DESCRIPTION,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
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

export const createOwnership = (id: string) => createInternalLabels(id);

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

export const sameValue = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const retryApiDisabled = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      // The API may still be propagating right after it is enabled.
      while: (error) => error._tag === "ServiceDisabled",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const getAgentPool = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : storagetransfer.getProjectsAgentPools({ name }).pipe(
        retryApiDisabled,
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );

export const getTransferJob = (jobName: string, projectId: string) =>
  jobName.length === 0
    ? Effect.succeed(undefined)
    : storagetransfer.getTransferJobs({ jobName, projectId }).pipe(
        retryApiDisabled,
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );

export const isDeletedJob = (job: storagetransfer.TransferJob | undefined) =>
  job?.status === "DELETED";

export const waitAgentPoolCreated = (name: string) =>
  getAgentPool(name).pipe(
    Effect.filterOrFail(
      (pool): pool is storagetransfer.AgentPool => pool !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (pool) => (pool.state ?? "") !== "DELETING",
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (pool) => {
        const state = pool.state ?? "CREATED";
        return state === "CREATED" || state === "STATE_UNSPECIFIED";
      },
      (pool) =>
        new ResourceNotReady({
          name,
          state: pool.state ?? "UNKNOWN",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.StorageTransfer.ResourceNotReady",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("GCP.StorageTransfer.ResourceNotResolved", () =>
      Effect.succeed(undefined),
    ),
  );

export const waitAgentPoolGone = (name: string) =>
  getAgentPool(name).pipe(
    Effect.flatMap((pool) =>
      pool === undefined
        ? Effect.void
        : Effect.fail(new ResourceStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.StorageTransfer.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.StorageTransfer.ResourceStillExists",
      () => Effect.void,
    ),
  );

export const listAgentPools = (projectId: string) =>
  retryApiDisabled(
    collectPages(
      storagetransfer.listProjectsAgentPools.pages({
        projectId,
        pageSize: 256,
      }),
      (page) => page.agentPools,
    ),
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as storagetransfer.AgentPool[]),
    ),
  );

export const listTransferJobs = (projectId: string) =>
  retryApiDisabled(
    collectPages(
      storagetransfer.listTransferJobs.pages({
        filter: JSON.stringify({ projectId }),
        pageSize: 256,
      }),
      (page) => page.transferJobs,
    ),
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as storagetransfer.TransferJob[]),
    ),
  );
