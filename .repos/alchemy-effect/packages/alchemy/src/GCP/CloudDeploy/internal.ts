import * as clouddeploy from "@distilled.cloud/gcp/clouddeploy_v1";
import * as Data from "effect/Data";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";
import { waitForOperation as waitForLongRunningOperation } from "../Operation.ts";

export const MAX_NAME_LENGTH = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.CloudDeploy.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.CloudDeploy.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "clouddeploy"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "clouddeploy",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, fallback);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
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

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/locations/${location}/${collection}/${value}`;
};

export const gkeClusterName = (
  value: string,
  project: string,
  location: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/locations/${location}/clusters/${value}`;
};

export const runLocationName = (
  value: string,
  project: string,
  location: string,
) => {
  if (value.startsWith("projects/")) return value.replace(/\/+$/, "");
  return `projects/${project}/locations/${lastSegment(value) || location}`;
};

export const membershipName = (
  value: string,
  project: string,
  location: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/locations/${location}/memberships/${value}`;
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const stringMap = (
  value: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

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

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBool = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

export const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
  previousLocation: string;
  nextLocation: string;
  extra?: boolean;
  previousParent?: string;
  nextParent?: string;
}) => {
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  const replace =
    (input.extra ?? false) ||
    parentChanged ||
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    input.previousLocation !== input.nextLocation;
  if (!replace) return undefined;
  const samePhysical =
    input.previousLocation === input.nextLocation &&
    !parentChanged &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

export const stripAutomationRule = (
  rule: clouddeploy.AutomationRule,
): clouddeploy.AutomationRule => ({
  advanceRolloutRule: rule.advanceRolloutRule
    ? {
        id: rule.advanceRolloutRule.id,
        wait: rule.advanceRolloutRule.wait,
        sourcePhases: rule.advanceRolloutRule.sourcePhases,
      }
    : undefined,
  promoteReleaseRule: rule.promoteReleaseRule
    ? {
        id: rule.promoteReleaseRule.id,
        destinationTargetId: rule.promoteReleaseRule.destinationTargetId,
        destinationPhase: rule.promoteReleaseRule.destinationPhase,
        wait: rule.promoteReleaseRule.wait,
      }
    : undefined,
  repairRolloutRule: rule.repairRolloutRule
    ? {
        id: rule.repairRolloutRule.id,
        phases: rule.repairRolloutRule.phases,
        repairPhases: rule.repairRolloutRule.repairPhases,
        jobs: rule.repairRolloutRule.jobs,
      }
    : undefined,
  timedPromoteReleaseRule: rule.timedPromoteReleaseRule
    ? {
        id: rule.timedPromoteReleaseRule.id,
        schedule: rule.timedPromoteReleaseRule.schedule,
        destinationTargetId: rule.timedPromoteReleaseRule.destinationTargetId,
        destinationPhase: rule.timedPromoteReleaseRule.destinationPhase,
        timeZone: rule.timedPromoteReleaseRule.timeZone,
      }
    : undefined,
});

export const stripAutomationRules = (
  rules: readonly clouddeploy.AutomationRule[] | undefined,
) => (rules ?? []).map(stripAutomationRule);

/**
 * Wait on a Cloud Deploy long-running operation (control-plane, usually under a minute).
 * `ALREADY_EXISTS` (a create race) counts as success; so does `NOT_FOUND`
 * when `notFoundOk` (deletes). Returns the final operation.
 */
export const waitForOperation = (
  operation: clouddeploy.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.suspend(() => {
    let latest = operation;
    return waitForLongRunningOperation(
      operation,
      (name) => {
        const get = clouddeploy.getProjectsLocationsOperations({ name }).pipe(
          Effect.tap((current) =>
            Effect.sync(() => {
              latest = current;
            }),
          ),
        );
        const observe: Effect.Effect<
          clouddeploy.Operation,
          clouddeploy.GetProjectsLocationsOperationsError,
          GcpOpContext
        > =
          options?.notFoundOk === true
            ? get.pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.succeed<clouddeploy.Operation>({ name, done: true }),
                ),
              )
            : get.pipe(
                // A just-returned operation can briefly 404 on read.
                Effect.retry({
                  while: (error) => error._tag === "NotFound",
                  times: 5,
                  schedule: Schedule.exponential("250 millis"),
                }),
              );
        return observe;
      },
      { budget: "10 minutes" },
    ).pipe(
      Effect.map(() => latest),
      // google.rpc.Code ALREADY_EXISTS = 6, NOT_FOUND = 5.
      Effect.catchTag("GCP.OperationFailed", (error) =>
        error.code === 6 || (options?.notFoundOk === true && error.code === 5)
          ? Effect.succeed(latest)
          : Effect.fail(error),
      ),
    );
  });

export const waitUntilExists = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<Exclude<A, undefined>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is Exclude<A, undefined> => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceNotResolved,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error instanceof ResourceStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const listAtLocation = <A, E, R>(
  project: string,
  region: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
): Effect.Effect<A[], E, R> =>
  // Some collections reject the `-` location wildcard; fall back to the
  // region.
  Effect.firstSuccessOf([
    list(`projects/${project}/locations/-`),
    list(`projects/${project}/locations/${region}`),
  ]);

export const listAtNested = <A, E, R>(
  project: string,
  region: string,
  nested: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
): Effect.Effect<A[], E, R> =>
  // Some collections reject the `-` location wildcard; fall back to the
  // region.
  Effect.firstSuccessOf([
    list(`projects/${project}/locations/-/${nested}`),
    list(`projects/${project}/locations/${region}/${nested}`),
  ]);

export const listLabeledPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
  labelsOf: (item: A) => Record<string, string | undefined> | null | undefined,
): Effect.Effect<A[], E, R> =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.filter((item) => hasAlchemyLabelMap(labelsOf(item))),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
