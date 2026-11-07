import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  DEFAULT_SERVER_SETTINGS,
  AuthDiagnosticsReadScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  UsageLimitSourceId,
  UsageTokenTotals,
  ServerConfig,
  type UsageSummary,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

const encodeConfig = Schema.encodeSync(ServerConfig);
const decodeClaims = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ scopes: Schema.Array(Schema.String), iat: Schema.Number, exp: Schema.Number }),
  ),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const requestSchema = Schema.Struct({
  _tag: Schema.String,
  tag: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  payload: Schema.optional(Schema.Unknown),
});
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(requestSchema));
const summary: UsageSummary = {
  contractVersion: 6,
  readAt: "2026-09-26T00:00:00Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-26"),
  untilDay: UsageDay.make("2026-09-26"),
  sources: [],
  pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 1,
  buckets: [
    {
      day: UsageDay.make("2026-09-26"),
      provider: "codex",
      model: "test-model",
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 5,
        outputTokens: 8,
        reasoningTokens: 3,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 1,
      unpricedRecords: 1,
      sessions: 1,
    },
  ],
};
const limits = {
  checkedAt: summary.readAt,
  windows: [
    {
      id: "session",
      kind: "session" as const,
      label: "Session",
      usedPercent: 80,
      resetsAt: "2026-09-26T05:00:00Z",
    },
  ],
  resetCredits: { availableCount: 2, nextCreditId: "test-credit" },
};
const config: ServerConfig = {
  environment: {
    environmentId: EnvironmentId.make("test"),
    label: "Test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "test",
    capabilities: { repositoryIdentity: true, connectionProbe: true, usageLimitSources: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  cwd: "/tmp",
  keybindingsConfigPath: "/tmp/keybindings.json",
  keybindings: [],
  issues: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    usageLimitSources: {
      [UsageLimitSourceId.make("hub")]: {
        kind: "cliproxy",
        enabled: true,
        url: "http://localhost:9999",
        managementKey: "",
      },
    },
  },
  providers: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", email: "test@example.test" },
      checkedAt: summary.readAt,
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: limits,
    },
  ],
};
const sources = [
  {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy",
    label: "Test hub",
    checkedAt: summary.readAt,
    accounts: [
      { id: "duplicate", driver: "codex", email: "test@example.test", usageLimits: limits },
      { id: "hub-only", driver: "claude", usageLimits: limits },
    ],
  },
];

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  );

// A local RPC fixture, not provider data. All CLI parsing, transport and auth storage are real.
const setupServer = Effect.fn(function* (streamConfig: boolean | "empty" | "failure" = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped();
  const requests: Array<typeof requestSchema.Type> = [];
  const sessions: Array<ReturnType<typeof decodeClaims>> = [];
  const server = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeSocket.NodeWS.WebSocketServer>((resolve) => {
          const server: NodeSocket.NodeWS.WebSocketServer = new NodeSocket.NodeWS.WebSocketServer(
            { port: 0, host: "127.0.0.1" },
            () => {
              resolve(server);
            },
          );
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) client.terminate();
            server.close(() => resolve());
          }),
      ),
  );
  server.on("connection", (socket, request) => {
    assert.equal(
      new URL(request.url!, "http://localhost").searchParams.get(
        ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      ),
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    const payload = request.headers.authorization?.slice("Bearer ".length).split(".")[0] ?? "";
    sessions.push(decodeClaims(Buffer.from(payload, "base64url").toString("utf8")));
    socket.on("message", (data) => {
      const request = decodeRequest(data.toString());
      requests.push(request);
      if (request._tag !== "Request") return;
      if (streamConfig === "empty" || streamConfig === "failure") {
        socket.send(
          encodeJson({
            _tag: "Exit",
            requestId: request.id,
            exit:
              streamConfig === "empty"
                ? { _tag: "Success", value: null }
                : {
                    _tag: "Failure",
                    cause: [
                      {
                        _tag: "Fail",
                        error: {
                          _tag: "EnvironmentAuthorizationError",
                          message: "fixture denied",
                          requiredScope: "orchestration:read",
                        },
                      },
                    ],
                  },
          }),
        );
        return;
      }
      if (streamConfig) {
        socket.send(
          encodeJson({
            _tag: "Chunk",
            requestId: request.id,
            values: [
              { version: 1, type: "snapshot", config: encodeConfig(config) },
              { version: 1, type: "usageLimitSourcesUpdated", payload: { sources: [] } },
              { version: 1, type: "usageLimitSourcesUpdated", payload: { sources } },
            ],
          }),
        );
      } else {
        socket.send(
          encodeJson({
            _tag: "Exit",
            requestId: request.id,
            exit: { _tag: "Success", value: summary },
          }),
        );
      }
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const stateDir = path.join(baseDir, "userdata");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(stateDir, "server-runtime.json"),
    encodeJson({
      version: 1,
      pid: process.pid,
      port: address.port,
      origin: `http://127.0.0.1:${address.port}`,
      startedAt: summary.readAt,
    }),
  );
  return { baseDir, requests, sessions };
});
const decodeLimits = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      accounts: Schema.Array(
        Schema.Struct({
          limits: Schema.Struct({
            windows: Schema.Array(Schema.Struct({ remainingPercent: Schema.Number })),
            resetCredits: Schema.Struct({ availableCount: Schema.Number }),
          }),
        }),
      ),
      notices: Schema.Array(Schema.String),
    }),
  ),
);

const decodeTokens = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      totalTokens: Schema.Number,
      totals: UsageTokenTotals,
      buckets: Schema.Array(Schema.Unknown),
    }),
  ),
);

const decodeCost = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      costUsd: Schema.Number,
      unpricedRecords: Schema.Number,
      costKind: Schema.String,
    }),
  ),
);

const testLayer = Layer.mergeAll(NodeServices.layer, TestConsole.layer);

describe("t3 usage", () => {
  it.effect("preserves domain errors and immediate RPC failure causes", () =>
    Effect.gen(function* () {
      for (const mode of ["empty", "failure"] as const) {
        const { baseDir } = yield* setupServer(mode);
        const result = yield* Effect.result(runCli(["usage", "limits", "--base-dir", baseDir]));
        assert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") continue;
        if (mode === "empty")
          assert.include(String(result.failure), "did not return a limits snapshot");
        else assert.propertyVal(result.failure.cause, "message", "fixture denied");
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("rejects invalid and reversed date windows before opening the environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const invalid = yield* Effect.result(
        runCli(["usage", "tokens", "--base-dir", baseDir, "--since", "2026-02-30"]),
      );
      assert.equal(invalid._tag, "Failure");
      if (invalid._tag === "Failure") assert.include(String(invalid.failure), "ShowHelp");
      const reversed = yield* Effect.result(
        runCli([
          "usage",
          "cost",
          "--base-dir",
          baseDir,
          "--since",
          "2026-09-26",
          "--until",
          "2026-09-01",
        ]),
      );
      assert.equal(reversed._tag, "Failure");
      if (reversed._tag === "Failure")
        assert.include(String(reversed.failure), "--since must not be after --until");
      assert.deepEqual(yield* fs.readDirectory(baseDir), []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect(
    "reads cached limits including hubs, deduplicates accounts and omits redemption actions",
    () =>
      Effect.gen(function* () {
        const { baseDir, requests } = yield* setupServer(true);
        yield* runCli(["usage", "limits", "--base-dir", baseDir]);
        const text = (yield* TestConsole.logLines).join("\n");
        const output = yield* decodeLimits(text);
        assert.equal(output.accounts.length, 2);
        assert.equal(output.accounts[0]?.limits.windows[0]?.remainingPercent, 20);
        assert.equal(output.accounts[0]?.limits.resetCredits.availableCount, 2);
        assert.notInclude(text, "redeem");
        assert.notInclude(text, "test-credit");
        assert.deepEqual(
          requests.filter((r) => r._tag === "Request").map((r) => r.tag),
          ["subscribeServerConfig"],
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("reads token totals over RPC without double-counting reasoning", () =>
    Effect.gen(function* () {
      const { baseDir, requests, sessions } = yield* setupServer();
      yield* runCli([
        "usage",
        "tokens",
        "--base-dir",
        baseDir,
        "--since",
        "2026-09-01",
        "--until",
        "2026-09-26",
      ]);
      const output = yield* decodeTokens((yield* TestConsole.logLines).join("\n"));
      assert.equal(output.totalTokens, 43);
      assert.deepEqual(
        sessions.map((session) => session.scopes),
        [[AuthDiagnosticsReadScope]],
      );
      assert.equal(sessions[0]!.exp - sessions[0]!.iat, 60_000);
      assert.equal(output.totals.reasoningTokens, 3);
      assert.equal(output.buckets.length, 1);
      assert.deepEqual(requests.find((r) => r._tag === "Request")?.payload, {
        sinceDay: "2026-09-01",
        untilDay: "2026-09-26",
        timeZone: "UTC",
      });
      assert.deepEqual(
        requests.filter((r) => r._tag === "Request").map((r) => r.tag),
        ["server.getUsageSummary"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("reports unpriced records instead of presenting missing costs as complete", () =>
    Effect.gen(function* () {
      const { baseDir, requests } = yield* setupServer();
      yield* runCli(["usage", "cost", "--base-dir", baseDir]);
      const output = yield* decodeCost((yield* TestConsole.logLines).join("\n"));
      assert.equal(output.costUsd, 0);
      assert.equal(output.unpricedRecords, 1);
      assert.equal(output.costKind, "api-equivalent");
      assert.deepEqual(
        requests.filter((r) => r._tag === "Request").map((r) => r.tag),
        ["server.getUsageSummary"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("reports a stopped server without creating runtime state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const result = yield* Effect.result(runCli(["usage", "limits", "--base-dir", baseDir]));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.include(String(result.failure), "running T3 Code server");
      assert.isFalse(yield* fs.exists(path.join(baseDir, "userdata", "state.sqlite")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("offers read-only limits, tokens and cost commands", () =>
    Effect.gen(function* () {
      yield* runCli(["usage", "--help"]);
      const output = (yield* TestConsole.logLines).join("\n");
      assert.include(output, "limits");
      assert.include(output, "tokens");
      assert.include(output, "cost");
    }).pipe(Effect.provide(TestConsole.layer)),
  );
  it.effect("rejects destructive commands before touching local state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      for (const args of [
        ["reset"],
        ["limits", "reset"],
        ["limits", "--consume-reset"],
        ["cost", "--set-price", "1"],
      ]) {
        const result = yield* Effect.result(runCli(["usage", ...args, "--base-dir", baseDir]));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.include(String(result.failure), "ShowHelp");
      }
      assert.deepEqual(yield* fs.readDirectory(baseDir), []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
