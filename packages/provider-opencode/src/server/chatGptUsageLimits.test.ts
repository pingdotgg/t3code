import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { readOpenCodeChatGptUsageLimits } from "./chatGptUsageLimits.ts";
import { chatGptWorkspaceScope } from "./chatGptWorkspaceScope.ts";

const testServices = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const oauth = {
  type: "oauth",
  methodID: "chatgpt-browser",
  access: "private-token",
  expires: 4_000_000_000_000,
  metadata: { accountID: "private-account" },
};
const usage = {
  rate_limit: {
    primary_window: { used_percent: 11, limit_window_seconds: 604800, reset_at: 1793085670 },
    secondary_window: null,
  },
  credits: { balance: "62500" },
  rate_limit_reset_credits: { available_count: 3 },
};
const database = Effect.fn("test.database")(function* (
  rows: ReadonlyArray<{ value: unknown; active: number | null }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(`${root}/opencode`);
  const filename = `${root}/opencode/opencode.db`;
  yield* Effect.sync(() => {
    const db = new NodeSqlite.DatabaseSync(filename);
    try {
      db.exec(
        "CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)",
      );
      rows.forEach((row, index) =>
        db
          .prepare("INSERT INTO credential VALUES (?, 'openai', ?, ?, ?)")
          .run(`credential-${index}`, JSON.stringify(row.value), row.active, index),
      );
    } finally {
      db.close();
    }
  });
  return { root, filename };
});

it.effect("reads the selected account read-only and preserves the OSS weekly window", () =>
  Effect.gen(function* () {
    const fixture = yield* database([
      { value: oauth, active: 1 },
      { value: { ...oauth, access: "inactive-token" }, active: 0 },
    ]);
    const fs = yield* FileSystem.FileSystem;
    const before = yield* fs.readFile(fixture.filename);
    const limits = yield* readOpenCodeChatGptUsageLimits({
      enabled: true,
      serverUrl: "",
      databasePath: fixture.filename,
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          NodeAssert.equal(request.method, "GET");
          NodeAssert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage");
          NodeAssert.equal(request.headers.authorization, "Bearer private-token");
          NodeAssert.equal(request.headers["chatgpt-account-id"], "private-account");
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(usage)));
        }),
      ),
    );
    NodeAssert.deepEqual(limits.windows, [
      {
        id: "chatgpt_10080m",
        kind: "weekly",
        label: "ChatGPT · Weekly",
        usageScope: "openai",
        workspaceScope: chatGptWorkspaceScope("private-account"),
        providerIds: [],
        usedPercent: 11,
        windowDurationMins: 10080,
        resetsAt: "2026-10-27T07:21:10.000Z",
      },
    ]);
    NodeAssert.match(limits.credentialFingerprint!, /^[0-9a-f]{64}$/);
    NodeAssert.equal(limits.resetCredits, undefined);
    NodeAssert.equal(JSON.stringify(limits).includes("private-"), false);
    NodeAssert.deepEqual(yield* fs.readFile(fixture.filename), before);
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.effect("recognizes independent logins by person and workspace, not the local row id", () =>
  Effect.gen(function* () {
    const fingerprint = (row: number, person: string, workspace: string) =>
      Effect.gen(function* () {
        const access = `header.${Buffer.from(JSON.stringify({ sub: person })).toString("base64url")}.signature`;
        const fixture = yield* database([
          ...Array.from({ length: row }, () => ({ value: { type: "key" }, active: 0 })),
          {
            value: { ...oauth, access, metadata: { accountID: workspace }, expires: -1 },
            active: 1,
          },
        ]);
        return (yield* readOpenCodeChatGptUsageLimits({
          enabled: true,
          serverUrl: "",
          databasePath: fixture.filename,
        })).credentialFingerprint;
      });
    const a = yield* fingerprint(0, "a", "team");
    NodeAssert.ok(a);
    NodeAssert.equal(yield* fingerprint(1, "a", "team"), a);
    NodeAssert.notEqual(yield* fingerprint(0, "b", "team"), a);
    NodeAssert.notEqual(yield* fingerprint(0, "a", "other"), a);
  }).pipe(
    Effect.scoped,
    Effect.provide(testServices),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("expired credential sent")),
    ),
  ),
);

it.effect("reads token-sharing logins with no account header", () =>
  Effect.gen(function* () {
    const fixture = yield* database([
      { value: { ...oauth, methodID: "chatgpt-token-sharing", metadata: {} }, active: null },
    ]);
    const limits = yield* readOpenCodeChatGptUsageLimits({
      enabled: true,
      serverUrl: "",
      databasePath: fixture.filename,
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          NodeAssert.equal(request.headers["chatgpt-account-id"], undefined);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                rate_limit: {
                  primary_window: {
                    used_percent: 125,
                    limit_window_seconds: 18000,
                    reset_at: 1793085670,
                  },
                  secondary_window: usage.rate_limit.primary_window,
                },
              }),
            ),
          );
        }),
      ),
    );
    NodeAssert.deepEqual(
      limits.windows.map((window) => [window.kind, window.usedPercent]),
      [
        ["session", 100],
        ["weekly", 11],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.effect.each(["key", "legacy"] as const)(
  "does not query an old OAuth login when the selected credential is %s",
  (scenario) =>
    Effect.gen(function* () {
      const fixture = yield* database([
        { value: oauth, active: scenario === "key" ? 0 : null },
        { value: { type: "key", key: "private-api-key" }, active: scenario === "key" ? 1 : 0 },
      ]);
      const limits = yield* readOpenCodeChatGptUsageLimits({
        enabled: true,
        serverUrl: "",
        databasePath: fixture.filename,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected usage request")),
        ),
      );
      NodeAssert.equal(limits.unavailable?.reason, "unsupported");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.effect("does not read host credentials for disabled or remote instances", () =>
  Effect.gen(function* () {
    for (const settings of [
      { enabled: false, serverUrl: "" },
      { enabled: true, serverUrl: "https://remote.example" },
    ]) {
      const limits = yield* readOpenCodeChatGptUsageLimits({
        ...settings,
        databasePath: "/host.db",
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ exists: () => Effect.die("unexpected file access") }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected request")),
        ),
      );
      NodeAssert.equal(limits.unavailable?.reason, "unsupported");
    }
  }).pipe(Effect.provide(testServices)),
);

it.effect("distinguishes unsupported authorization from failed or malformed responses", () =>
  Effect.gen(function* () {
    const fixture = yield* database([{ value: oauth, active: 1 }]);
    for (const [status, reason] of [
      [403, "unsupported"],
      [401, "probeFailed"],
      [429, "probeFailed"],
      [200, "probeFailed"],
    ] as const) {
      const limits = yield* readOpenCodeChatGptUsageLimits({
        enabled: true,
        serverUrl: "",
        databasePath: fixture.filename,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ error: "private-token" }, { status }),
              ),
            ),
          ),
        ),
      );
      NodeAssert.equal(limits.unavailable?.reason, reason);
      NodeAssert.equal(JSON.stringify(limits).includes("private-token"), false);
    }
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.effect("missing or legacy databases do not create credentials or issue requests", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const filename = `${root}/legacy.db`;
    const read = readOpenCodeChatGptUsageLimits({
      enabled: true,
      serverUrl: "",
      databasePath: filename,
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected usage request")),
      ),
    );
    NodeAssert.equal((yield* read).unavailable?.reason, "unsupported");
    NodeAssert.equal(yield* fs.exists(filename), false);
    yield* Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(filename);
      db.close();
    });
    NodeAssert.equal((yield* read).unavailable?.reason, "unsupported");
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.effect.each(["expired", "request-failed"] as const)(
  "clears stale limits when the current login is expired or another workspace member's request failed: %s",
  (failure) =>
    Effect.gen(function* () {
      const fixture = yield* database([{ value: oauth, active: 1 }]);
      const input = {
        enabled: true,
        serverUrl: "",
        databasePath: fixture.filename,
      };
      const published = yield* readOpenCodeChatGptUsageLimits(input).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(usage))),
          ),
        ),
      );
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(fixture.filename);
        try {
          db.prepare("UPDATE credential SET id = ?, value = ?").run(
            failure === "expired" ? "credential-0" : "second-member",
            JSON.stringify({ ...oauth, expires: failure === "expired" ? -1 : oauth.expires }),
          );
        } finally {
          db.close();
        }
      });
      const probed = yield* readOpenCodeChatGptUsageLimits(input).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            NodeAssert.equal(failure, "request-failed");
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 })),
            );
          }),
        ),
      );
      if (failure === "expired") NodeAssert.match(probed.unavailable?.message ?? "", /expired/);
      else NodeAssert.notEqual(probed.credentialFingerprint, published.credentialFingerprint);
      NodeAssert.deepEqual(probed.windows, []);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
);
