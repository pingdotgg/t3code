import * as SDK from "@distilled.cloud/neon";
import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as SQL from "alchemy/SQL/Postgres";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Api from "../src/Api.ts";
import Events from "../src/Events.ts";
import { resources } from "../src/resources.ts";

const { test } = Test.make({
  providers: Neon.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE ?? "testing",
  stage: "test-neon-compute-tutorial",
});

test.provider(
  "a real private upload dispatches the Effect event and persists status",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { project, branch, uploads, publicAssets, api, events } =
        yield* stack.deploy(
          Effect.gen(function* () {
            const backend = yield* resources;
            const api = yield* Api;
            const events = yield* Events;
            return { ...backend, api, events };
          }),
        );
      const scope = {
        project_id: project.projectId,
        branch_id: branch.branchId,
      };
      const observed = yield* SDK.listProjectBranchBuckets(scope);
      expect(
        observed.buckets.find((bucket) => bucket.name === uploads.bucketName)
          ?.access_level,
      ).toBe("private");
      expect(
        observed.buckets.find(
          (bucket) => bucket.name === publicAssets.bucketName,
        )?.access_level,
      ).toBe("public_read");
      const triggers = yield* SDK.listProjectBranchTriggers(scope);
      expect(
        triggers.triggers.some(
          (trigger) =>
            trigger.type === "schedule" &&
            trigger.function_slug === events.slug &&
            trigger.function_path === "/__alchemy/neon/cron/Nightly" &&
            trigger.enabled,
        ),
      ).toBe(true);
      expect(
        triggers.triggers.some(
          (trigger) =>
            trigger.type === "storage_object_created" &&
            trigger.function_slug === api.slug &&
            trigger.function_path === "/__alchemy/neon/bucket/ProcessUploads" &&
            trigger.enabled,
        ),
      ).toBe(true);
      const http = yield* HttpClient.HttpClient;
      const apiUrl = api.url.replace(/\/$/, "");
      const health = yield* http.get(`${apiUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Health HTTP ${response.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
      );
      expect(health.status).toBe(200);
      for (const path of ["/api/uploads", "/api/settings", "/api/me"]) {
        expect((yield* http.get(`${apiUrl}${path}`)).status).toBe(401);
      }
      expect(
        (yield* http.get(`${apiUrl}/api/uploads`, {
          headers: { authorization: "Bearer invalid.jwt.signature" },
        })).status,
      ).toBe(401);
      expect(
        (yield* http.post(`${apiUrl}/__alchemy/neon/bucket/ProcessUploads`))
          .status,
      ).toBe(403);

      const sql = yield* SQL.Postgres({
        url: Redacted.make(branch.connectionUri),
      });
      const files = yield* Neon.bucketStorageClient(uploads);
      const id = "10000000-0000-4000-8000-000000000001";
      const key = `incoming/tutorial-test/${id}`;
      const body = "real upload event";
      yield* sql`INSERT INTO uploads (id, owner_id, object_key, filename, content_type, expected_bytes)
    VALUES (${id}, 'tutorial-test', ${key}, 'event.txt', 'text/plain', ${body.length})`;
      const signed = yield* files.presign(key, "PUT", {
        contentType: "text/plain",
        expiresIn: 120,
      });
      const put = yield* http.execute(
        HttpClientRequest.put(signed).pipe(
          HttpClientRequest.bodyText(body, "text/plain"),
        ),
      );
      expect(put.status).toBe(200);
      const [processed] = yield* sql<{
        status: string;
        actual_bytes: string | number;
      }>`SELECT status, actual_bytes FROM uploads WHERE id = ${id}`.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          times: 8,
          until: (rows) => rows[0]?.status === "ready",
        }),
      );
      expect(processed?.status).toBe("ready");
      expect(Number(processed?.actual_bytes)).toBe(body.length);
      expect(
        (yield* sql`SELECT invocation_id FROM upload_events WHERE object_key = ${key}`)
          .length,
      ).toBeGreaterThan(0);
      const download = yield* files.presign(key, "GET", { expiresIn: 60 });
      const response = yield* http.get(download);
      expect(yield* response.text).toBe(body);
      const anonymousUrl = yield* Effect.sync(() => {
        const url = new URL(download);
        url.search = "";
        return url.href;
      });
      expect((yield* http.get(anonymousUrl)).status).not.toBe(200);
      yield* stack.destroy();
      const gone = yield* SDK.getProject({
        project_id: project.projectId,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          times: 8,
          until: (value) => value,
        }),
      );
      expect(gone).toBe(true);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  { timeout: 120_000 },
);
