import * as Effect from "effect/Effect";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import type { App } from "./App.ts";
import type { Bucket } from "./Bucket.ts";
import type { Database } from "./Database.ts";
import type { Project } from "./Project.ts";

export type InputObject<T extends object> = {
  [Key in keyof T]: Input<T[Key]>;
};

export const isInputObject = <T extends object>(
  value: Input<T>,
): value is InputObject<T> & Input<T> =>
  typeof value === "object" &&
  value !== null &&
  !Output.isOutput(value) &&
  !Effect.isEffect(value);

export const isPrismaDevId = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("dev:");

export const concreteIdOf = (value: unknown): string | undefined =>
  typeof value === "string" && !isPrismaDevId(value) ? value : undefined;

export const concreteIdsChanged = (
  oldId: string | undefined,
  newId: string | undefined,
) => oldId !== undefined && newId !== undefined && newId !== oldId;

const resolveId = (label: string, value: unknown) =>
  Effect.gen(function* () {
    if (typeof value === "string") return value;
    if (Output.isOutput(value)) {
      const accessor = yield* value as Output.Output<string>;
      return yield* accessor;
    }
    return yield* Effect.fail(new Error(`Unable to resolve Prisma ${label}.`));
  });

export const unresolvedProjectIdOf = (project: string | Project | undefined) =>
  concreteIdOf(
    typeof project === "string" ? project : (project?.projectId as unknown),
  );

export const resolveProjectId = (project: string | Project) =>
  resolveId(
    "project id",
    typeof project === "string" ? project : (project.projectId as unknown),
  );

export const unresolvedDatabaseIdOf = (
  database: string | Database | undefined,
) =>
  concreteIdOf(
    typeof database === "string" ? database : (database?.databaseId as unknown),
  );

export const resolveDatabaseId = (database: string | Database) =>
  resolveId(
    "database id",
    typeof database === "string" ? database : (database.databaseId as unknown),
  );

export const unresolvedBucketIdOf = (bucket: string | Bucket | undefined) =>
  concreteIdOf(
    typeof bucket === "string" ? bucket : (bucket?.bucketId as unknown),
  );

export const resolveBucketId = (bucket: string | Bucket) =>
  resolveId(
    "bucket id",
    typeof bucket === "string" ? bucket : (bucket.bucketId as unknown),
  );

export const unresolvedAppIdOf = (app: string | App | undefined) =>
  concreteIdOf(typeof app === "string" ? app : (app?.appId as unknown));

export const resolveAppId = (app: string | App) =>
  resolveId("app id", typeof app === "string" ? app : (app.appId as unknown));
