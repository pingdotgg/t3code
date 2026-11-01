import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { alchemyLabelKeys, createInternalLabels } from "../Labels.ts";

export const MAX_ID_LENGTH = 63;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parseDatabaseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const after = (segment: string) => {
    const at = parts.lastIndexOf(segment);
    return at >= 0 && parts[at + 1] ? parts[at + 1]! : "";
  };
  const project = after("projects");
  const databaseId = after("databases");
  return {
    project,
    databaseId: databaseId || lastSegment(name),
    collectionGroup: after("collectionGroups"),
    indexId: after("indexes"),
    backupScheduleId: after("backupSchedules"),
    userCredsId: after("userCreds"),
  };
};

export const databaseIdOf = (value: string) =>
  value.includes("/databases/")
    ? parseDatabaseName(value).databaseId
    : lastSegment(value);

export const databaseResourceName = (project: string, databaseId: string) =>
  `projects/${project}/databases/${databaseId}`;

export const databaseNameOf = (project: string, database: string) => {
  if (database.includes("/databases/")) {
    const parsed = parseDatabaseName(database);
    return databaseResourceName(parsed.project || project, parsed.databaseId);
  }
  return databaseResourceName(project, lastSegment(database));
};

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `f${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) next = "firestore";
  if (next.length < 4) {
    next = `${next}xxxx`.slice(0, maxLength).replace(/-+$/g, "");
  }
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, maxLength - 1)}0`;
  }
  return next.slice(0, maxLength);
};

export const toResourceId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      maxLength,
    );
  });

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const stringFromMap = (
  map: firestore.DocumentMap | undefined,
  key: string,
): string | undefined => {
  const value = map?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const getDatabaseByName = (name: string) =>
  firestore.getProjectsDatabases({ name }).pipe(
    Effect.map((database) =>
      database.deleteTime !== undefined ? undefined : database,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const retryConcurrentChanges = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export { alchemyLabelKeys, createInternalLabels };
