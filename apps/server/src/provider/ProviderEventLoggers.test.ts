// @effect-diagnostics nodeBuiltinImport:off -- seeds and backdates real files under logs/provider/ so the production store's startup retention is exercised.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";

const CANARY = "provider-event-log-canary-7f3a";

// Builds the production logger store against a temp T3 home, writes a prompt (native stream) and a tool
// result (canonical stream) carrying CANARY, closes the scope so pending batches flush, then reports what is
// left on disk under logs/provider/.
const runProviderLogTurn = (providerEventLogs: boolean | undefined) =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-event-logs-"));
    try {
      const turn = yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const loggers = yield* ProviderEventLoggers.make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            ...(providerEventLogs === undefined ? {} : { providerEventLogs }),
          }),
        );
        const threadId = ThreadId.make("thread-provider-event-logs");
        if (loggers.native) {
          yield* loggers.native.write({ type: "prompt.offer", text: CANARY }, threadId);
        }
        if (loggers.canonical) {
          yield* loggers.canonical.write({ type: "tool.result", output: CANARY }, threadId);
        }
        return {
          hasNative: loggers.native !== undefined,
          hasCanonical: loggers.canonical !== undefined,
          dir: config.providerLogsDir,
        };
      }).pipe(
        Effect.scoped,
        Effect.provide(ResourceAttribution.layer),
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      const files = NodeFS.existsSync(turn.dir) ? NodeFS.readdirSync(turn.dir) : [];
      const filesWithCanary = files.filter((file) =>
        NodeFS.readFileSync(NodePath.join(turn.dir, file), "utf8").includes(CANARY),
      );
      return { ...turn, files, filesWithCanary };
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer));

describe("ProviderEventLoggers", () => {
  it.effect("writes prompt and tool events under logs/provider by default", () =>
    Effect.gen(function* () {
      const result = yield* runProviderLogTurn(undefined);
      assert.isTrue(result.hasNative);
      assert.isTrue(result.hasCanonical);
      assert.isAbove(result.filesWithCanary.length, 0);
    }),
  );

  it.effect("creates no provider log store or file when provider event logs are disabled", () =>
    Effect.gen(function* () {
      const result = yield* runProviderLogTurn(false);
      assert.isFalse(result.hasNative);
      assert.isFalse(result.hasCanonical);
      assert.deepEqual(result.files, []);
    }),
  );

  // Store construction applies retention to existing files, so an expired log only survives if the opt-out
  // returns before the store exists. Uses the live clock because retention compares mtimes to Clock time.
  it.live(
    "leaves an existing expired provider log untouched when provider event logs are disabled",
    () =>
      Effect.gen(function* () {
        const enabled = yield* runWithExpiredProviderLog(true);
        assert.isFalse(
          enabled.exists,
          "the fixture is expired: an enabled store's retention removes it",
        );

        const disabled = yield* runWithExpiredProviderLog(false);
        assert.isTrue(disabled.exists);
        assert.equal(disabled.contents, EXPIRED_LOG_CONTENTS);
        assert.equal(disabled.mtimeMs, disabled.seededMtimeMs);
      }),
  );
});

const EXPIRED_LOG_NAME = "events.expired-thread.log";
const EXPIRED_LOG_CONTENTS =
  '[2026-01-01T00:00:00.000Z] NTIVE: {"synthetic":"expired-provider-log"}\n';
const EXPIRED_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Seeds an expired provider log in logs/provider/, builds the loggers, closes the scope, and reports the file.
const runWithExpiredProviderLog = (providerEventLogs: boolean) =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-event-logs-"));
    try {
      return yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const filePath = NodePath.join(config.providerLogsDir, EXPIRED_LOG_NAME);
        NodeFS.mkdirSync(config.providerLogsDir, { recursive: true });
        NodeFS.writeFileSync(filePath, EXPIRED_LOG_CONTENTS);
        const expiredAt = new Date(Date.now() - EXPIRED_AGE_MS);
        NodeFS.utimesSync(filePath, expiredAt, expiredAt);
        const seededMtimeMs = NodeFS.statSync(filePath).mtimeMs;

        yield* ProviderEventLoggers.make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, { ...config, providerEventLogs }),
          Effect.scoped,
          Effect.provide(ResourceAttribution.layer),
        );

        const exists = NodeFS.existsSync(filePath);
        return {
          exists,
          seededMtimeMs,
          contents: exists ? NodeFS.readFileSync(filePath, "utf8") : undefined,
          mtimeMs: exists ? NodeFS.statSync(filePath).mtimeMs : undefined,
        };
      }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer));
