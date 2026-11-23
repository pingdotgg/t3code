import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { makeOpenCodeUsageLimitsProbe } from "./usageLimitsProbe.ts";

it.effect.each(["Go", "ChatGPT", "remote"] as const)(
  "reads %s limits without a Console workspace",
  (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filename = (yield* Path.Path).join(dir, "opencode-local.db");
      if (kind === "ChatGPT") {
        const db = new NodeSqlite.DatabaseSync(filename);
        try {
          db.exec(
            "CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)",
          );
          db.prepare("INSERT INTO credential VALUES ('id', 'openai', ?, 1, 0)").run(
            JSON.stringify({
              type: "oauth",
              methodID: "chatgpt-headless",
              access: "test-token",
              expires: 4_000_000_000_000,
            }),
          );
        } finally {
          db.close();
        }
      }
      let goUsageReads = 0;
      let pathReads = 0;

      const server = HttpClient.make((request) => {
        if (request.url === "https://chatgpt.com/backend-api/wham/usage") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                rate_limit: {
                  primary_window: {
                    used_percent: 11,
                    limit_window_seconds: 604800,
                    reset_at: 1793085670,
                  },
                },
              }),
            ),
          );
        }
        if (request.url === "https://opencode.ai/zen/go/v1/usage") {
          goUsageReads += 1;
          assert.strictEqual(request.headers.authorization, "Bearer test-go-key");
          const window = { percent: 10, resetsAt: "2026-11-01T00:00:00.000Z" };
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ usage: { rolling: window, weekly: window, monthly: window } }),
            ),
          );
        }
        return Effect.die("unexpected usage endpoint");
      });
      const read = yield* makeOpenCodeUsageLimitsProbe({
        config: {
          enabled: true,
          binaryPath: "opencode",
          serverUrl: kind === "remote" ? "https://example.test" : "",
        },
        runtime: Effect.succeed({ generation: "v2", version: "2.0.18" }),
        consoleLimits: Effect.succeed({
          checkedAt: "2026-09-03T12:00:00Z",
          windows: [],
          unavailable: { reason: "unsupported" },
          externalUsage: { label: "Zen", url: "https://opencode.ai/console/zen" },
        }),
        environment: {
          XDG_DATA_HOME: dir,
          OPENCODE_AUTH_CONTENT: JSON.stringify(
            kind === "ChatGPT" ? {} : { "opencode-go": { type: "api", key: "test-go-key" } },
          ),
        },
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, server),
        Effect.provide(
          Layer.mock(OpenCodeRuntime.OpenCodeRuntime)({
            createOpenCodeSdkClient: () => assert.fail("usage probes do not open sessions"),
            runOpenCodeCommand: () =>
              Effect.sync(() => ({
                stdout: filename,
                stderr: "",
                code: ++pathReads === 1 && kind === "ChatGPT" ? 1 : 0,
              })),
          }),
        ),
      );
      let limits = yield* read;
      if (kind === "remote") {
        assert.strictEqual(limits.unavailable?.reason, "unsupported");
        assert.strictEqual(pathReads, 0);
        assert.strictEqual(goUsageReads, 0);
        return;
      }
      if (kind === "ChatGPT") {
        assert.strictEqual(limits.unavailable?.reason, "probeFailed");
        limits = yield* read;
      }
      assert.deepStrictEqual(
        limits.windows.map((window) => window.kind),
        kind === "Go" ? ["session", "weekly", "monthly"] : ["weekly"],
      );
      assert.strictEqual(limits.externalUsage?.url, "https://opencode.ai/console/zen");
      assert.strictEqual(goUsageReads, kind === "Go" ? 1 : 0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
