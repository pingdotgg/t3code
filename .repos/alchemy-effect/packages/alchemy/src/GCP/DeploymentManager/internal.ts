import * as deploymentmanager from "@distilled.cloud/gcp/deploymentmanager_v2";
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
  "GCP.DeploymentManager.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.DeploymentManager.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "deployment"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `d${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const labelsToRecord = (
  labels: readonly deploymentmanager.DeploymentLabelEntry[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (labels ?? [])
      .filter(
        (entry): entry is { key: string; value: string } =>
          typeof entry.key === "string" &&
          entry.key.length > 0 &&
          typeof entry.value === "string",
      )
      .map((entry) => [entry.key, entry.value]),
  );

export const recordToLabels = (
  labels: Record<string, string>,
): deploymentmanager.DeploymentLabelEntry[] =>
  Object.entries(labels).map(([key, value]) => ({ key, value }));

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
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

/**
 * Wait on a Deployment Manager operation (Compute-style `status: "DONE"`).
 * Deployments of a handful of resources finish in a minute or two.
 * `*ALREADY_EXISTS` counts as success; so does a not-found error when
 * `notFoundOk` (deletes). Returns the final operation.
 */
export const waitForOperation = (
  project: string,
  operation: deploymentmanager.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.suspend(() => {
    let latest = operation;
    return waitForLongRunningOperation(
      operation,
      (name) => {
        const get = deploymentmanager
          .getOperations({ project, operation: lastSegment(name) })
          .pipe(
            Effect.tap((current) =>
              Effect.sync(() => {
                latest = current;
              }),
            ),
          );
        const observe: Effect.Effect<
          deploymentmanager.Operation,
          deploymentmanager.GetOperationsError,
          GcpOpContext
        > =
          options?.notFoundOk === true
            ? get.pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.succeed<deploymentmanager.Operation>({
                    name,
                    status: "DONE",
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
      { budget: "20 minutes" },
    ).pipe(
      Effect.map(() => latest),
      Effect.catchTag("GCP.OperationFailed", (error) => {
        const reason = (error.reason ?? "").toUpperCase();
        return reason.endsWith("ALREADY_EXISTS") ||
          (options?.notFoundOk === true &&
            (reason === "NOT_FOUND" || reason === "RESOURCE_NOT_FOUND"))
          ? Effect.succeed(latest)
          : Effect.fail(error);
      }),
    );
  });

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.DeploymentManager.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.DeploymentManager.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const getDeployment = (project: string, deployment: string) =>
  deploymentmanager
    .getDeployments({ project, deployment })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listOwnedDeployments = (project: string) =>
  collectPages(
    deploymentmanager.listDeployments.pages({
      project,
      maxResults: 500,
    }),
    (page) => page.deployments,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) =>
        Object.keys(labelsToRecord(item.labels)).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
    ),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as deploymentmanager.Deployment[]),
    ),
  );

export const getManifest = (
  project: string,
  deployment: string,
  manifest: string | undefined,
) => {
  if (manifest === undefined || manifest.length === 0) {
    return Effect.succeed(undefined);
  }
  return deploymentmanager
    .getManifests({
      project,
      deployment,
      manifest: lastSegment(manifest),
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
};

export const settleDeployment = (
  project: string,
  item: deploymentmanager.Deployment,
) =>
  Effect.gen(function* () {
    const operation = item.operation;
    if (operation !== undefined && operation.status !== "DONE") {
      yield* waitForOperation(project, operation, { notFoundOk: true });
    }
  });
