import * as managedidentities from "@distilled.cloud/gcp/managedidentities_v1";
import * as Data from "effect/Data";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";
import { waitForOperation as waitForLongRunningOperation } from "../Operation.ts";

export const GLOBAL_LOCATION = "global";
export const DEFAULT_NETWORK = "default";
export const DEFAULT_ADMIN = "setupadmin";
export const DOMAIN_SUFFIX = ".alch.test";
export const FIRST_SEGMENT_MAX = 15;
export const MAX_NAME_LENGTH = 63;
export const PAGE_SIZE = 100;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.ManagedIdentities.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.ManagedIdentities.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.ManagedIdentities.ResourceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.ManagedIdentities.ResourceFailed",
)<{
  name: string;
  state: string;
  details: string | undefined;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (
  name: string,
  fallback = "ad",
  maxLength = MAX_NAME_LENGTH,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "a"}${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return fallback.slice(0, maxLength);
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, maxLength - 1)}0`;
  }
  return next.slice(0, maxLength);
};

export const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

export const globalParent = (project: string) =>
  `projects/${project}/locations/${GLOBAL_LOCATION}`;

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : GLOBAL_LOCATION,
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

export const domainResourceOf = (value: string, project: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/")) return trimmed;
  return `${globalParent(project)}/domains/${trimmed}`;
};

export const domainNameOf = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/domains/")) return parseName(trimmed, "domains").id;
  return trimmed;
};

export const networkOf = (value: string, project: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return `projects/${project}/global/networks/${DEFAULT_NETWORK}`;
  }
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/global/networks/${trimmed}`;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "ad",
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

export const toDomainName = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit.toLowerCase();
    if (existing !== undefined) return domainNameOf(existing);
    const first = rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: FIRST_SEGMENT_MAX,
        lowercase: true,
      }),
      "ad",
      FIRST_SEGMENT_MAX,
    );
    return `${first}${DOMAIN_SUFFIX}`;
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(
    [...(left ?? [])].map((value) => value.toLowerCase()).sort(),
  ) ===
  JSON.stringify([...(right ?? [])].map((value) => value.toLowerCase()).sort());

export const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
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
      input.nextId !== input.previousId);
  if (!replace) return undefined;
  const samePhysical =
    !parentChanged &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

const READY_STATES = new Set([
  "READY",
  "ACTIVE",
  "CONNECTED",
  "PERFORMING_MAINTENANCE",
]);
const FAILED_STATES = new Set(["ERROR", "FAILED", "UNAVAILABLE"]);

export const isReadyState = (state: string | undefined) =>
  READY_STATES.has((state ?? "").toUpperCase());

export const isFailedState = (state: string | undefined) =>
  FAILED_STATES.has((state ?? "").toUpperCase());

/**
 * Wait on a Managed Microsoft AD long-running operation. Domain creation takes up to ~60 minutes.
 * `ALREADY_EXISTS` (a create race) counts as success; so does `NOT_FOUND`
 * when `notFoundOk` (deletes). Returns the final operation.
 */
export const waitForOperation = (
  operation: managedidentities.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.suspend(() => {
    let latest = operation;
    return waitForLongRunningOperation(
      operation,
      (name) => {
        const get = managedidentities
          .getProjectsLocationsGlobalOperations({ name })
          .pipe(
            Effect.tap((current) =>
              Effect.sync(() => {
                latest = current;
              }),
            ),
          );
        const observe: Effect.Effect<
          managedidentities.Operation,
          managedidentities.GetProjectsLocationsGlobalOperationsError,
          GcpOpContext
        > =
          options?.notFoundOk === true
            ? get.pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.succeed<managedidentities.Operation>({
                    name,
                    done: true,
                  }),
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
      { budget: "90 minutes", interval: "30 seconds" },
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

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ManagedIdentities.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ManagedIdentities.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.asVoid,
  );

export const waitUntilReady = <
  A extends { readonly state?: string; readonly statusMessage?: string },
  E extends { readonly _tag: string },
  R,
>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
  stateOf: (value: A) => string | undefined,
  detailsOf?: (value: A) => string | undefined,
  options?: {
    times?: number;
    interval?: `${number} seconds`;
  },
): Effect.Effect<
  A,
  E | ResourceNotResolved | ResourceNotReady | ResourceFailed,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => {
        const state = stateOf(value) ?? "";
        return (
          isReadyState(state) || isFailedState(state) || state.length === 0
        );
      },
      (value) => new ResourceNotReady({ name, state: stateOf(value) ?? "" }),
    ),
    Effect.filterOrFail(
      (value) => !isFailedState(stateOf(value)),
      (value) =>
        new ResourceFailed({
          name,
          state: stateOf(value) ?? "",
          details: detailsOf?.(value),
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ManagedIdentities.ResourceNotReady" ||
        error._tag === "GCP.ManagedIdentities.ResourceNotResolved",
      // Domains take up to ~60 minutes to become READY.
      times: options?.times ?? 180,
      schedule: Schedule.spaced(options?.interval ?? "30 seconds"),
    }),
  );

export const listLabeledPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
  labelsOf: (item: A) => Record<string, string | undefined> | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.filter((item) => hasAlchemyLabelMap(labelsOf(item))),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listDomains = (project: string) =>
  listLabeledPages(
    managedidentities.listProjectsLocationsGlobalDomains.pages({
      parent: globalParent(project),
      pageSize: PAGE_SIZE,
    }),
    (page) => page.domains,
    (item) => item.labels,
  );

export const listPeerings = (project: string) =>
  listLabeledPages(
    managedidentities.listProjectsLocationsGlobalPeerings.pages({
      parent: globalParent(project),
      pageSize: PAGE_SIZE,
    }),
    (page) => page.peerings,
    (item) => item.labels,
  );

export const listBackups = (project: string) =>
  Effect.gen(function* () {
    const wildcard = yield* listLabeledPages(
      managedidentities.listProjectsLocationsGlobalDomainsBackups.pages({
        parent: `${globalParent(project)}/domains/-`,
        pageSize: PAGE_SIZE,
      }),
      (page) => page.backups,
      (item) => item.labels,
    );
    if (wildcard.length > 0) {
      return wildcard;
    }
    const domains = yield* managedidentities.listProjectsLocationsGlobalDomains
      .pages({
        parent: globalParent(project),
        pageSize: PAGE_SIZE,
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.domains ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
    const groups = yield* Effect.forEach(
      domains.filter((domain) => (domain.name ?? "").length > 0),
      (domain) =>
        listLabeledPages(
          managedidentities.listProjectsLocationsGlobalDomainsBackups.pages({
            parent: domain.name!,
            pageSize: PAGE_SIZE,
          }),
          (page) => page.backups,
          (item) => item.labels,
        ),
      { concurrency: 4 },
    );
    return groups.flat();
  });
