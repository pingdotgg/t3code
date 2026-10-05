import * as osconfig from "@distilled.cloud/gcp/osconfig_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { stripInternalLabels } from "../Labels.ts";

export const MAX_ID_LENGTH = 63;
export const DEFAULT_ACTION = "UPSERT";
export const DEFAULT_STATE = "STOPPED";

export type OrchestratedResource =
  osconfig.GoogleCloudOsconfigV2__OrchestratedResource;
export type OrchestrationScope =
  osconfig.GoogleCloudOsconfigV2__OrchestrationScope;
export type PolicyOrchestratorBody =
  osconfig.GoogleCloudOsconfigV2__PolicyOrchestrator;

export class OsconfigNotResolved extends Data.TaggedError(
  "GCP.OSConfig.NotResolved",
)<{
  name: string;
}> {}

export class OsconfigStillExists extends Data.TaggedError(
  "GCP.OSConfig.StillExists",
)<{
  name: string;
}> {}

export class FolderNotResolved extends Data.TaggedError(
  "GCP.OSConfig.FolderNotResolved",
)<{
  project: string;
}> {}

export class OrganizationNotResolved extends Data.TaggedError(
  "GCP.OSConfig.OrganizationNotResolved",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "orch"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "o"}${next}`;
  next = next.slice(0, MAX_ID_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) next = fallback;
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, MAX_ID_LENGTH - 1)}0`;
  }
  return next.slice(0, MAX_ID_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "orch",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, fallback);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const folderParent = (value: string) =>
  value.startsWith("folders/") ? value : `folders/${lastSegment(value)}`;

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const projectParent = (value: string) =>
  value.startsWith("projects/") ? value : `projects/${lastSegment(value)}`;

export const globalParent = (scopeParent: string) =>
  `${scopeParent.replace(/\/+$/, "")}/locations/global`;

export const resourceName = (parent: string, policyOrchestratorId: string) =>
  `${parent}/policyOrchestrators/${policyOrchestratorId}`;

export const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf("policyOrchestrators");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const orgsAt = parts.lastIndexOf("organizations");
  const foldersAt = parts.lastIndexOf("folders");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    organization: orgsAt >= 0 && parts[orgsAt + 1] ? parts[orgsAt + 1]! : "",
    folder: foldersAt >= 0 && parts[foldersAt + 1] ? parts[foldersAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : "global",
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

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

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

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

const OUTPUT_ONLY_ASSIGNMENT = new Set([
  "rolloutState",
  "baseline",
  "deleted",
  "etag",
  "uid",
  "revisionCreateTime",
  "reconciling",
  "name",
  "revisionId",
]);

export const assignmentPayload = (
  assignment: osconfig.OSPolicyAssignment | undefined,
): osconfig.OSPolicyAssignment | undefined => {
  if (assignment === undefined) return undefined;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(assignment)) {
    if (!OUTPUT_ONLY_ASSIGNMENT.has(key) && value !== undefined) {
      next[key] = value;
    }
  }
  return next as osconfig.OSPolicyAssignment;
};

export const orchestratedPayload = (
  resource: OrchestratedResource | undefined,
): OrchestratedResource | undefined => {
  if (resource === undefined) return undefined;
  return {
    id: resource.id,
    osPolicyAssignmentV1Payload: assignmentPayload(
      resource.osPolicyAssignmentV1Payload,
    ),
  };
};

export const defaultOrchestratedResource = (
  resourceId: string,
): OrchestratedResource => ({
  id: resourceId,
  osPolicyAssignmentV1Payload: {
    instanceFilter: {
      inventories: [{ osShortName: "debian" }],
    },
    osPolicies: [
      {
        id: "alchemy-noop",
        mode: "VALIDATION",
        resourceGroups: [
          {
            resources: [
              {
                id: "noop-exec",
                exec: {
                  validate: {
                    interpreter: "SHELL",
                    script: "exit 100",
                  },
                },
              },
            ],
          },
        ],
      },
    ],
    rollout: {
      disruptionBudget: { percent: 100 },
      minWaitDuration: "0s",
    },
  },
});

const getOperation = (name: string) =>
  name.startsWith("folders/")
    ? osconfig.getFoldersLocationsOperations({ name })
    : name.startsWith("organizations/")
      ? osconfig.getOrganizationsLocationsOperations({ name })
      : osconfig.getProjectsLocationsOperations({ name });

/**
 * Wait for an OS Config policy-orchestrator operation. An operation that
 * finished with `ALREADY_EXISTS` (6) is a lost create race; `notFoundOk`
 * also accepts `NOT_FOUND` (5).
 */
export const waitForOperation = (
  operation: osconfig.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      getOperation(name).pipe(
        Effect.catchTag("NotFound", (error) =>
          options?.notFoundOk === true
            ? Effect.succeed<osconfig.Operation>({ name, done: true })
            : Effect.fail(error),
        ),
      ),
    { budget: "10 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    Effect.asVoid,
  );

export const waitUntilExists = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | OsconfigNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new OsconfigNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof OsconfigNotResolved,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | OsconfigStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new OsconfigStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof OsconfigStillExists,
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.asVoid,
  );

export const collectOrchestrators = <E extends { readonly _tag: string }>(
  pages: Stream.Stream<
    osconfig.GoogleCloudOsconfigV2__ListPolicyOrchestratorsResponse,
    | osconfig.NotFound
    | osconfig.Forbidden
    | osconfig.ServiceDisabled
    | osconfig.GcpOpError,
    osconfig.GcpOpContext
  >,
) =>
  pages.pipe(
    Stream.flatMap((page) =>
      Stream.fromIterable(page.policyOrchestrators ?? []),
    ),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag(["NotFound", "Forbidden", "ServiceDisabled"], () =>
      Effect.succeed([] as PolicyOrchestratorBody[]),
    ),
  );

const ancestryParent = (name: string) =>
  name.startsWith("projects/")
    ? resourcemanager.getProjects({ name }).pipe(
        Effect.map((resource) => resource.parent),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      )
    : name.startsWith("folders/")
      ? resourcemanager.getFolders({ name }).pipe(
          Effect.map((folder) => folder.parent),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        )
      : Effect.succeed(undefined);

export const tryResolveFolder = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("folders/")) return current;
      if (current.startsWith("organizations/")) return undefined;
      current = yield* ancestryParent(current);
    }
    return undefined;
  });

export const resolveFolder = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return folderParent(explicit);
    if (existing !== undefined) return folderParent(existing);
    const resolved = yield* tryResolveFolder();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new FolderNotResolved({ project: env.project });
    }
    return resolved;
  });

export const tryResolveOrganization = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("organizations/")) return current;
      current = yield* ancestryParent(current);
    }
    return undefined;
  });

export const resolveOrganization = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return organizationParent(explicit);
    if (existing !== undefined) return organizationParent(existing);
    const resolved = yield* tryResolveOrganization();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new OrganizationNotResolved({ project: env.project });
    }
    return resolved;
  });

export const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
  previousParent: string;
  nextParent: string;
}) => {
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.nextId !== input.previousId;
  const parentChanged =
    input.previousParent !== "" &&
    input.nextParent !== "" &&
    input.previousParent !== input.nextParent;
  if (!idChanged && !parentChanged) return undefined;
  return {
    action: "replace" as const,
    deleteFirst:
      !parentChanged &&
      input.previousId !== undefined &&
      input.nextId === input.previousId,
  };
};
