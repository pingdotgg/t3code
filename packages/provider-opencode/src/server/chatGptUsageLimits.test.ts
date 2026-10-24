import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { resolveUsageLimitsAfterProbe } from "@t3tools/provider-core/server/usageLimits";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { readOpenCodeChatGptUsageLimits } from "./chatGptUsageLimits.ts";

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
      environment: { XDG_DATA_HOME: fixture.root },
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
        id: "chatgpt_primary",
        kind: "weekly",
        label: "ChatGPT · Weekly",
        usedPercent: 11,
        windowDurationMins: 10080,
        resetsAt: "2026-10-27T07:21:10.000Z",
      },
    ]);
    NodeAssert.match(limits.credentialFingerprint!, /^[0-9a-f]{64}$/);
    NodeAssert.equal(limits.resetCredits, undefined);
    NodeAssert.equal(JSON.stringify(limits).includes("private-"), false);
    NodeAssert.deepEqual(yield* fs.readFile(fixture.filename), before);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses OPENCODE_DB and reads token-sharing logins with no account header", () =>
  Effect.gen(function* () {
    const fixture = yield* database([
      { value: { ...oauth, methodID: "chatgpt-token-sharing", metadata: {} }, active: null },
    ]);
    const limits = yield* readOpenCodeChatGptUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { XDG_DATA_HOME: "/not-the-default", OPENCODE_DB: fixture.filename },
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["key", "inactive"] as const)(
  "does not query an old OAuth login when the selected credential is %s",
  (scenario) =>
    Effect.gen(function* () {
      const fixture = yield* database([
        { value: oauth, active: 0 },
        ...(scenario === "key"
          ? [{ value: { type: "key", key: "private-api-key" }, active: 1 }]
          : []),
      ]);
      const limits = yield* readOpenCodeChatGptUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: { OPENCODE_DB: fixture.filename },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected usage request")),
        ),
      );
      NodeAssert.equal(limits.unavailable?.reason, "unsupported");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not read host credentials for disabled or remote instances", () =>
  Effect.gen(function* () {
    for (const settings of [
      { enabled: false, serverUrl: "" },
      { enabled: true, serverUrl: "https://remote.example" },
    ]) {
      const limits = yield* readOpenCodeChatGptUsageLimits({ ...settings, environment: {} }).pipe(
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
  }).pipe(Effect.provide(NodeServices.layer)),
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
        environment: { OPENCODE_DB: fixture.filename },
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("missing or legacy databases do not create credentials or issue requests", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const filename = `${root}/legacy.db`;
    const read = readOpenCodeChatGptUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { OPENCODE_DB: filename },
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["expired", "request-failed"] as const)(
  "clears stale limits after switching to an account whose probe is %s",
  (failure) =>
    Effect.gen(function* () {
      const fixture = yield* database([{ value: oauth, active: 1 }]);
      const input = {
        enabled: true,
        serverUrl: "",
        environment: { OPENCODE_DB: fixture.filename },
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
          db.prepare("UPDATE credential SET value = ?").run(
            JSON.stringify({
              ...oauth,
              metadata: { accountID: "second-account" },
              expires: failure === "expired" ? -1 : oauth.expires,
            }),
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
      NodeAssert.equal(probed.unavailable?.reason, "probeFailed");
      NodeAssert.notEqual(probed.credentialFingerprint, published.credentialFingerprint);
      NodeAssert.equal(resolveUsageLimitsAfterProbe({ published, probed }), probed);
      NodeAssert.deepEqual(probed.windows, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
