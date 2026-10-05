import * as firebase from "@distilled.cloud/gcp/firebase_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME = 32;
export const MAX_PACKAGE_SUFFIX = 40;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Firebase.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectParent = (project: string) => `projects/${project}`;

export const encodeDisplayName = (
  labels: Record<string, string>,
  displayName: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  const combined =
    displayName && displayName.length > 0 ? `${marker} ${displayName}` : marker;
  return combined.slice(0, 1024);
};

export const parseDisplayName = (
  displayName: string | undefined,
): {
  labels: Record<string, string>;
  displayName: string | undefined;
} => {
  if (!displayName?.startsWith("[alchemy ")) {
    return { labels: {}, displayName };
  }
  const end = displayName.indexOf("]");
  if (end < 0) return { labels: {}, displayName };
  const labels: Record<string, string> = {};
  for (const part of displayName.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = displayName.slice(end + 1).trim();
  return { labels, displayName: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (displayName: string | undefined) =>
  Object.keys(parseDisplayName(displayName).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, displayName: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseDisplayName(displayName);
    return yield* hasAlchemyLabels(id, labels);
  });

export const toDisplayName = (
  id: string,
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: MAX_DISPLAY_NAME,
      lowercase: true,
    });
  });

export const ownedDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    const labels = yield* createInternalLabels(id);
    const user = yield* toDisplayName(id, requested, existing);
    return encodeDisplayName(labels, user);
  });

export const packageNameOf = (
  id: string,
  requested: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const suffix = yield* createPhysicalName({
      id,
      maxLength: MAX_PACKAGE_SUFFIX,
      lowercase: true,
    });
    const cleaned = suffix.replace(/[^a-z0-9]/g, "");
    return `com.alchemy.test.${cleaned || "app"}`;
  });

/**
 * Wait for a Firebase Management operation and return its final state
 * (the created app name is in `response.name`). An operation that
 * finished with `ALREADY_EXISTS` (6) is a lost create race. A freshly
 * started operation can briefly read as NOT_FOUND; keep polling.
 */
export const waitForOperation = (operation: firebase.Operation) => {
  let latest = operation;
  return waitForGcpOperation(
    operation,
    (name) =>
      firebase.getOperations({ name }).pipe(
        Effect.catchTag("NotFound", () =>
          Effect.succeed<firebase.Operation>({ name, done: false }),
        ),
        Effect.tap((current) =>
          Effect.sync(() => {
            latest = current;
          }),
        ),
      ),
    { budget: "5 minutes" },
  ).pipe(
    Effect.map(() => latest),
    Effect.catchIf(
      (error) => error._tag === "GCP.OperationFailed" && error.code === 6,
      () => Effect.succeed(latest),
    ),
  );
};

export const listAndroidApps = (project: string, showDeleted = false) =>
  firebase.listProjectsAndroidApps
    .pages({
      parent: projectParent(project),
      pageSize: 100,
      showDeleted,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.apps ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as firebase.AndroidApp[]),
      ),
    );
