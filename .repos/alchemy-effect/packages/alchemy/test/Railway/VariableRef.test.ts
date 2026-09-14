import * as railway from "@distilled.cloud/railway";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asVariableMap = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
};

const readVariables = (
  projectId: string,
  environmentId: string,
  serviceId?: string,
) =>
  railway
    .variables({
      projectId,
      environmentId,
      ...(serviceId !== undefined ? { serviceId } : {}),
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const waitUntilVariableGone = (
  projectId: string,
  environmentId: string,
  name: string,
  serviceId?: string,
) =>
  readVariables(projectId, environmentId, serviceId).pipe(
    Effect.map((vars) =>
      Object.hasOwn(vars, name) ? ("found" as const) : ("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const isPostgresUri = (value: string | undefined) =>
  value !== undefined &&
  (value.startsWith("postgres://") || value.startsWith("postgresql://"));

test.provider(
  "upserting DATABASE_URL: Railway.ref(Db, DATABASE_URL) stores the template, not a resolved URI",
  (stack) =>
    Effect.gen(function* () {
      expect(Railway.ref({ LogicalId: "Db" }, "DATABASE_URL")).toEqual(
        "${{Db.DATABASE_URL}}",
      );
      expect(Railway.ref("shared", "SENTRY_DSN")).toEqual(
        "${{shared.SENTRY_DSN}}",
      );

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const db = yield* Railway.Postgres("Db", {
            project,
            environment,
            public: false,
          });
          const template = Railway.ref(db, "DATABASE_URL");
          const databaseUrl = yield* Railway.Variable("DatabaseUrl", {
            project,
            environment,
            name: "DATABASE_URL",
            value: template,
          });
          const sentry = yield* Railway.Variable("SentryDsn", {
            project,
            environment,
            name: "SENTRY_DSN",
            value: "https://example.ingest.sentry.io/1",
          });
          const sentryRef = yield* Railway.Variable("SentryDsnRef", {
            project,
            environment,
            service: db,
            name: "SENTRY_DSN",
            value: Railway.ref("shared", "SENTRY_DSN"),
          });
          return {
            project,
            environment,
            db,
            databaseUrl,
            sentry,
            sentryRef,
            template,
          };
        }),
      );

      expect(created.template).toEqual("${{Db.DATABASE_URL}}");
      expect(isPostgresUri(created.template)).toBe(false);

      expect(created.databaseUrl.name).toEqual("DATABASE_URL");
      expect(created.databaseUrl.serviceId).toBeUndefined();
      expect(Object.hasOwn(created.databaseUrl, "value")).toBe(false);

      const shared = yield* readVariables(
        created.databaseUrl.projectId,
        created.databaseUrl.environmentId,
      );
      expect(shared.DATABASE_URL).toEqual(created.template);
      expect(shared.DATABASE_URL).toEqual("${{Db.DATABASE_URL}}");
      expect(shared.DATABASE_URL).not.toEqual(created.db.connectionUri);
      expect(isPostgresUri(shared.DATABASE_URL)).toBe(false);
      expect(shared.SENTRY_DSN).toEqual("https://example.ingest.sentry.io/1");

      const onDb = yield* readVariables(
        created.db.projectId,
        created.db.environmentId,
        created.db.serviceId,
      );
      expect(onDb.SENTRY_DSN).toEqual(Railway.ref("shared", "SENTRY_DSN"));
      expect(onDb.SENTRY_DSN).toEqual("${{shared.SENTRY_DSN}}");
      expect(onDb.DATABASE_URL).not.toEqual(created.template);
      expect((onDb.DATABASE_URL ?? "").includes("${{")).toBe(true);

      yield* stack.destroy();

      const variableGone = yield* waitUntilVariableGone(
        created.databaseUrl.projectId,
        created.databaseUrl.environmentId,
        created.databaseUrl.name,
      );
      expect(variableGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
