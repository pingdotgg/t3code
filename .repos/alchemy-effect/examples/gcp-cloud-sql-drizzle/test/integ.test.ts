import * as run from "@distilled.cloud/gcp/run_v2";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack, { providers } from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: providers(),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
// Distilled routes the regional secret to its regional endpoint.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// The service is built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-cloud-sql-drizzle", () => {
  // Creating a Cloud SQL instance takes 5–10 minutes (and deleting one a
  // few more); everything else is bounded well below that.
  const stack = beforeAll(deploy(Stack), { timeout: 1_500_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const outputs = yield* stack;
      yield* destroy(Stack);
      if (outputs === undefined) return;

      const project = outputs.connectionName?.split(":")[0] ?? "";
      const instance = yield* sqladmin
        .getInstances({ project, instance: outputs.instanceName })
        .pipe(
          Effect.map(() => "present" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(instance).toBe("gone");

      const secret = yield* secretmanager
        .getProjectsLocationsSecrets({ name: outputs.passwordSecretName })
        .pipe(
          Effect.map(() => "present" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(secret).toBe("gone");

      const service = yield* run
        .getProjectsLocationsServices({ name: outputs.serviceName })
        .pipe(
          Effect.map(() => "present" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(service).toBe("gone");
    }),
    { timeout: 1_200_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  const request = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
  ) =>
    HttpClient.execute(
      body === undefined
        ? HttpClientRequest.make(method)(url)
        : HttpClientRequest.make(method)(url).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
    );

  /** Query the database directly through the Cloud SQL Data API. */
  const executeSql = (
    outputs: {
      instanceName: string;
      connectionName: string | undefined;
      databaseName: string;
      userName: string;
      passwordSecretName: string;
    },
    sqlStatement: string,
  ) =>
    sqladmin
      .executeSqlInstances({
        project: outputs.connectionName?.split(":")[0] ?? "",
        instance: outputs.instanceName,
        body: {
          database: outputs.databaseName,
          user: outputs.userName,
          passwordSecretVersion: `${outputs.passwordSecretName}/versions/latest`,
          sqlStatement,
        },
      })
      .pipe(
        Effect.map((response) => {
          const result = response.results?.at(-1);
          const columns = (result?.columns ?? []).map((c) => c.name ?? "");
          return (result?.rows ?? []).map((row) =>
            Object.fromEntries(
              columns.map((name, index) => [
                name,
                row.values?.[index]?.nullValue
                  ? null
                  : row.values?.[index]?.value,
              ]),
            ),
          );
        }),
        Effect.orDie,
        Effect.provide(GcpHttp),
      );

  test(
    "applies the drizzle migration at deploy time",
    Effect.gen(function* () {
      const outputs = yield* stack;
      const applied = yield* executeSql(
        outputs,
        "SELECT name FROM __alchemy_migrations",
      );
      expect(applied).toHaveLength(1);
      expect(String(applied[0]?.name)).toMatch(/^\d{14}_/);
      const columns = yield* executeSql(
        outputs,
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'todos' ORDER BY column_name",
      );
      expect(columns.map((row) => row.column_name)).toEqual([
        "done",
        "id",
        "title",
      ]);
    }),
    { timeout: 120_000 },
  );

  test(
    "serves CRUD over Drizzle on the Cloud SQL socket",
    Effect.gen(function* () {
      const outputs = yield* stack;
      const baseUrl = baseUrlOf(outputs.url);
      yield* getWhenReady(`${baseUrl}/`);

      const id = "aaaaaaaa-0000-4000-8000-000000000001";
      // The project-level cloudsql.client grant (under an IAM Condition) can
      // take a few minutes to reach a fresh service account; until then the
      // socket refuses the connection and the service answers 500.
      const empty = yield* request("DELETE", `${baseUrl}/todos/${id}`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (response) => response.status !== 500,
          times: 42,
        }),
      );
      expect(empty.status).toBe(204);

      const created = yield* request("POST", `${baseUrl}/todos`, {
        id,
        title: "Ship the Cloud SQL guide",
      });
      expect(created.status).toBe(201);
      expect(yield* created.json).toEqual([
        { id, title: "Ship the Cloud SQL guide", done: false },
      ]);

      // The row is really in Cloud SQL.
      const rows = yield* executeSql(
        outputs,
        `SELECT id, title, done FROM todos WHERE id = '${id}'`,
      );
      expect(rows).toEqual([
        { id, title: "Ship the Cloud SQL guide", done: "false" },
      ]);

      const updated = yield* request("PATCH", `${baseUrl}/todos/${id}`, {
        done: true,
      });
      expect(updated.status).toBe(200);
      expect(yield* updated.json).toEqual({
        id,
        title: "Ship the Cloud SQL guide",
        done: true,
      });

      const listed = yield* request("GET", `${baseUrl}/todos`);
      expect(listed.status).toBe(200);
      expect(yield* listed.json).toEqual([
        { id, title: "Ship the Cloud SQL guide", done: true },
      ]);

      const invalid = yield* request("POST", `${baseUrl}/todos`, {
        id: "not-a-uuid",
        title: "",
      });
      expect(invalid.status).toBe(400);

      const deleted = yield* request("DELETE", `${baseUrl}/todos/${id}`);
      expect(deleted.status).toBe(204);
      const gone = yield* request("GET", `${baseUrl}/todos/${id}`);
      expect(gone.status).toBe(404);
      expect(
        yield* executeSql(outputs, `SELECT id FROM todos WHERE id = '${id}'`),
      ).toEqual([]);
    }),
    { timeout: 600_000 },
  );
});
