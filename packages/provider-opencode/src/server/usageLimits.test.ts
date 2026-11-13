import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { mergeUsageLimits, readOpenCodeIntegrationUsageLimits } from "./usageLimits.ts";

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

const MINIMAX_RESPONSE = {
  base_resp: { status_code: 0, status_msg: "success" },
  model_remains: [
    {
      model_name: "general",
      current_interval_remaining_percent: 85,
      current_interval_status: 1,
      end_time: 1794328907302,
      current_weekly_remaining_percent: 91,
      current_weekly_status: 1,
      weekly_end_time: 1794905017270,
    },
    {
      model_name: "video",
      current_interval_remaining_percent: 0,
      current_interval_status: 2,
      current_weekly_remaining_percent: 0,
      current_weekly_status: 2,
    },
  ],
};

/** A credential store with one active key for the given integration. */
const storeWithCredential = (integrationId: string, key: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "opencode-limits-test-" });
    const dataHome = path.join(dir, ".local", "share");
    yield* fileSystem.makeDirectory(path.join(dataHome, "opencode"), { recursive: true });
    const db = yield* openDatabase(path.join(dataHome, "opencode", "opencode.db"));
    yield* db.unsafe(
      "CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)",
    );
    yield* db.unsafe(
      "INSERT INTO credential (id, integration_id, value, active, time_created) VALUES (?, ?, ?, 1, 0)",
      ["cred-1", integrationId, JSON.stringify({ type: "key", key })],
    );
    return { dir, dataHome };
  });

describe("readOpenCodeIntegrationUsageLimits", () => {
  it.effect("reads an integration's own quota instead of the OpenCode Console budget", () =>
    Effect.gen(function* () {
      const { dir, dataHome } = yield* storeWithCredential("minimax-coding-plan", "sk-cp-plan-key");

      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(MINIMAX_RESPONSE))),
      );
      const result = yield* readOpenCodeIntegrationUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          HOME: dir,
          XDG_DATA_HOME: dataHome,
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.strictEqual(result.windows.length, 2);
      const [interval, weekly] = result.windows;
      assert.strictEqual(interval?.id, "minimax-coding-plan_interval");
      assert.strictEqual(interval?.label, "MiniMax Token Plan · Interval");
      assert.strictEqual(interval?.usedPercent, 15);
      assert.strictEqual(weekly?.id, "minimax-coding-plan_weekly");
      assert.strictEqual(weekly?.usedPercent, 9);
      assert.isDefined(interval?.resetsAt);
      assert.isDefined(result.credentialFingerprint);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reports only the bucket that meters the plan", () =>
    Effect.gen(function* () {
      const { dir, dataHome } = yield* storeWithCredential("minimax-coding-plan", "sk-cp-plan-key");

      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(MINIMAX_RESPONSE))),
      );
      const result = yield* readOpenCodeIntegrationUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          HOME: dir,
          XDG_DATA_HOME: dataHome,
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      // The video bucket is exhausted; reporting it would exhaust the plan too.
      assert.isTrue(result.windows.every((window) => window.usedPercent < 100));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("never sends a key that MiniMax did not issue", () =>
    Effect.gen(function* () {
      const { dir, dataHome } = yield* storeWithCredential("minimax-coding-plan", "sk-third-party");

      const client = HttpClient.make((request) =>
        Effect.die(`The key left the machine: ${request.url}`),
      );
      const result = yield* readOpenCodeIntegrationUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          HOME: dir,
          XDG_DATA_HOME: dataHome,
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.deepStrictEqual(result.windows, []);
      assert.isUndefined(result.credentialFingerprint);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

describe("mergeUsageLimits", () => {
  it("keeps the integration windows and drops the unavailable marker", () => {
    const merged = mergeUsageLimits(
      {
        checkedAt: "2026-11-10T00:00:00.000Z",
        windows: [],
        credentialFingerprint: "go-account",
        unavailable: { reason: "unsupported" },
      },
      {
        checkedAt: "2026-11-10T00:00:00.000Z",
        windows: [
          {
            id: "minimax-coding-plan_weekly",
            kind: "weekly",
            label: "MiniMax Token Plan · Weekly",
            usedPercent: 9,
          },
        ],
      },
    );
    assert.strictEqual(merged.windows.length, 1);
    assert.strictEqual(merged.credentialFingerprint, "go-account");
    assert.isUndefined(merged.unavailable);
  });

  it("keeps the Console budget untouched when no integration reports a quota", () => {
    const console = {
      checkedAt: "2026-11-10T00:00:00.000Z",
      windows: [],
      unavailable: { reason: "unsupported" as const },
    };
    assert.deepStrictEqual(
      mergeUsageLimits(console, { checkedAt: console.checkedAt, windows: [] }),
      console,
    );
  });

  it("tells two accounts apart when only the integration key differs", () => {
    const console = {
      checkedAt: "2026-11-10T00:00:00.000Z",
      windows: [],
      credentialFingerprint: "go-account",
    };
    const merged = mergeUsageLimits(console, {
      checkedAt: console.checkedAt,
      windows: [
        {
          id: "minimax-coding-plan_weekly",
          kind: "weekly",
          label: "MiniMax Token Plan · Weekly",
          usedPercent: 9,
        },
      ],
      credentialFingerprint: "minimax-account",
    });
    assert.strictEqual(merged.credentialFingerprint, "go-account.minimax-account");
  });
});
