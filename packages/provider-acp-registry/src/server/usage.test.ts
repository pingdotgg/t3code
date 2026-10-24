import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import { mistralVibeUsageReader } from "./usage.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UPDATED_AT = 1_780_000_000_000;

interface SessionFixture {
  readonly tokenUsage: {
    readonly cachedInputTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly updatedAt: number;
  readonly model: string | null;
}

const writeSession = Effect.fn("writeSession")(function* (
  unifiedRoot: string,
  sessionId: string,
  fixture: SessionFixture,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const generationDir = path.join(unifiedRoot, sessionId, "generations", "0000000000000001");
  yield* fileSystem.makeDirectory(generationDir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(unifiedRoot, sessionId, "CURRENT"),
    JSON.stringify({ generation: "0000000000000001", session_id: sessionId, snapshot_sequence: 1 }),
  );
  yield* fileSystem.writeFileString(
    path.join(generationDir, "projection-state.json"),
    JSON.stringify({
      snapshot: {
        session: { tokenUsage: fixture.tokenUsage, updatedAt: fixture.updatedAt },
      },
    }),
  );
  yield* fileSystem.writeFileString(
    path.join(generationDir, "runtime-state.json"),
    JSON.stringify({
      session_metadata: { active_model: fixture.model },
    }),
  );
});

const writeCatalog = Effect.fn("writeCatalog")(function* (
  unifiedRoot: string,
  entries: ReadonlyArray<{
    readonly sessionId: string;
    readonly fixture: SessionFixture;
  }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(
    path.join(unifiedRoot, ".session-index.json"),
    JSON.stringify({
      catalog_version: 1,
      entries: entries.map(({ sessionId, fixture }) => ({
        session_id: sessionId,
        identity: { session_id: sessionId },
        metadata: { active_model: fixture.model },
        session: { tokenUsage: fixture.tokenUsage, updatedAt: fixture.updatedAt },
      })),
    }),
  );
});

const scan = Effect.fn("scan")(function* (input: {
  readonly instances: ReadonlyArray<{
    readonly id: string;
    readonly config: unknown;
    readonly environment: NodeJS.ProcessEnv;
  }>;
  readonly windowStartMs?: number;
  readonly home?: string;
}) {
  if (mistralVibeUsageReader.kind !== "scan") throw new Error("Expected a scan reader");
  const scan = mistralVibeUsageReader.scan({
    instances: input.instances.map((instance) => ({
      instanceId: ProviderInstanceId.make(instance.id),
      config: instance.config as ReturnType<typeof decodeSettings> | undefined,
      environment: instance.environment,
      configured: true,
    })),
    settings: DEFAULT_SERVER_SETTINGS,
    windowStartMs: input.windowStartMs ?? 0,
    retentionCutoffMs: 0,
    awaitRefresh: true,
  });
  return input.home === undefined
    ? yield* scan
    : yield* Effect.provideService(scan, HostProcess.HomeDirectory, input.home);
});

const makeVibeHome = Effect.fn("makeVibeHome")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "mistral-vibe-usage-test-" });
  // realPath the temp dir (which exists) before joining; macOS temp paths are
  // symlinked and `vibe-home` does not exist yet.
  const vibeHome = path.join(yield* fileSystem.realPath(temp), "vibe-home");
  const unifiedRoot = path.join(vibeHome, "logs", "session", "unified");
  yield* fileSystem.makeDirectory(unifiedRoot, { recursive: true });
  return { vibeHome, unifiedRoot };
});

describe("mistralVibeUsageReader", () => {
  it.effect("reads cumulative session usage from published generations", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: {
          cachedInputTokens: 400,
          inputTokens: 1000,
          outputTokens: 50,
          totalTokens: 1050,
        },
        updatedAt: UPDATED_AT,
        model: "mistral-large-4",
      });
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      assert.strictEqual(sources.length, 1);
      const source = sources[0]!;
      assert.strictEqual(source.dir, unifiedRoot);
      assert.strictEqual(source.status, "ok");
      const records = source.files?.flatMap((file) => file.records) ?? [];
      assert.strictEqual(records.length, 1);
      const record = records[0]!;
      assert.strictEqual(record.provider, "mistral");
      assert.strictEqual(record.sessionId, SESSION_ID);
      assert.strictEqual(record.model, "mistral-large-4");
      assert.strictEqual(record.timestampMs, UPDATED_AT);
      assert.deepStrictEqual(record.totals, {
        uncachedInputTokens: 600,
        cachedInputTokens: 400,
        cacheCreationTokens: 0,
        outputTokens: 50,
        reasoningTokens: 0,
      });
      assert.strictEqual(record.reportedCostUsd, null);
      assert.strictEqual(record.speed, "standard");
      assert.strictEqual(record.dedupeKey, `mistral:${unifiedRoot}:session:${SESSION_ID}`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the fresher catalog reading and its model", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: {
          cachedInputTokens: 100,
          inputTokens: 500,
          outputTokens: 10,
          totalTokens: 510,
        },
        updatedAt: UPDATED_AT,
        model: null,
      });
      // The catalog applied the recovery journal, so it is newer than the
      // published generation, and it carries the model the generation lacks.
      yield* writeCatalog(unifiedRoot, [
        {
          sessionId: SESSION_ID,
          fixture: {
            tokenUsage: {
              cachedInputTokens: 200,
              inputTokens: 900,
              outputTokens: 20,
              totalTokens: 920,
            },
            updatedAt: UPDATED_AT + 60_000,
            model: "glm-5-3",
          },
        },
      ]);
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      const records = sources[0]?.files?.flatMap((file) => file.records) ?? [];
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.model, "glm-5-3");
      assert.strictEqual(records[0]?.timestampMs, UPDATED_AT + 60_000);
      assert.deepStrictEqual(records[0]?.totals, {
        uncachedInputTokens: 700,
        cachedInputTokens: 200,
        cacheCreationTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the published generation when it is newer than the catalog", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: { cachedInputTokens: 0, inputTokens: 300, outputTokens: 5, totalTokens: 305 },
        updatedAt: UPDATED_AT + 120_000,
        model: "mistral-large-4",
      });
      yield* writeCatalog(unifiedRoot, [
        {
          sessionId: SESSION_ID,
          fixture: {
            tokenUsage: {
              cachedInputTokens: 0,
              inputTokens: 100,
              outputTokens: 1,
              totalTokens: 101,
            },
            updatedAt: UPDATED_AT,
            model: "mistral-large-4",
          },
        },
      ]);
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      const records = sources[0]?.files?.flatMap((file) => file.records) ?? [];
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.timestampMs, UPDATED_AT + 120_000);
      assert.strictEqual(records[0]?.totals.uncachedInputTokens, 300);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("scans only Mistral Vibe instances and dedupes shared vibe homes", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        updatedAt: UPDATED_AT,
        model: "mistral-large-4",
      });
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_devin",
            config: decodeSettings({ agentId: "devin" }),
            environment: { VIBE_HOME: vibeHome },
          },
          { id: "acpRegistry", config: undefined, environment: { VIBE_HOME: vibeHome } },
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
          {
            id: "acpRegistry_mistral_vibe_2",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
          {
            id: "acpRegistry_local_vibe",
            config: decodeSettings({ source: "local", commandPath: "/tools/vibe-acp" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      // One source per distinct vibe home, not per instance.
      assert.strictEqual(sources.length, 1);
      const records = sources[0]?.files?.flatMap((file) => file.records) ?? [];
      assert.strictEqual(records.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("defaults to ~/.vibe when VIBE_HOME is unset", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "mistral-vibe-home-test-" });
      const home = yield* fileSystem.realPath(temp);
      const unifiedRoot = path.join(home, ".vibe", "logs", "session", "unified");
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        updatedAt: UPDATED_AT,
        model: "mistral-large-4",
      });
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: {},
          },
        ],
        home,
      });
      assert.strictEqual(sources.length, 1);
      assert.strictEqual(sources[0]?.dir, unifiedRoot);
      assert.strictEqual(sources[0]?.files?.flatMap((file) => file.records).length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing session root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "mistral-vibe-missing-test-",
      });
      const vibeHome = path.join(yield* fileSystem.realPath(temp), "vibe-home");
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      assert.strictEqual(sources.length, 1);
      assert.strictEqual(sources[0]?.dir, path.join(vibeHome, "logs", "session", "unified"));
      assert.strictEqual(sources[0]?.files, null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("drops sessions outside the window or without usage", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        updatedAt: UPDATED_AT,
        model: "mistral-large-4",
      });
      yield* writeSession(unifiedRoot, OTHER_SESSION_ID, {
        tokenUsage: { cachedInputTokens: 0, inputTokens: 99, outputTokens: 9, totalTokens: 108 },
        updatedAt: UPDATED_AT - 1,
        model: "mistral-large-4",
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A session whose latest generation has no token usage yet.
      const emptyDir = path.join(
        unifiedRoot,
        "cccccccc-0000-0000-0000-000000000000",
        "generations",
        "0000000000000001",
      );
      yield* fileSystem.makeDirectory(emptyDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(emptyDir, "projection-state.json"),
        JSON.stringify({ snapshot: { session: { tokenUsage: null, updatedAt: UPDATED_AT } } }),
      );
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
        windowStartMs: UPDATED_AT,
      });
      const records = sources[0]?.files?.flatMap((file) => file.records) ?? [];
      assert.deepStrictEqual(
        records.map((record) => record.sessionId),
        [SESSION_ID],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("tolerates corrupt session files and catalogs", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        updatedAt: UPDATED_AT,
        model: "mistral-large-4",
      });
      // A session whose projection is unreadable JSON.
      const brokenDir = path.join(unifiedRoot, OTHER_SESSION_ID, "generations", "0000000000000001");
      yield* fileSystem.makeDirectory(brokenDir, { recursive: true });
      yield* fileSystem.writeFileString(path.join(brokenDir, "projection-state.json"), "{invalid");
      // A corrupt catalog must not break the scan.
      yield* fileSystem.writeFileString(path.join(unifiedRoot, ".session-index.json"), "{invalid");
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      // The unreadable session is reported, not silently dropped.
      assert.strictEqual(sources[0]?.status, "partial");
      const records = sources[0]?.files?.flatMap((file) => file.records) ?? [];
      assert.deepStrictEqual(
        records.map((record) => record.sessionId),
        [SESSION_ID],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the catalog when the published projection has no usable usage", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // An empty projection (a fresh session before its first turn) with the
      // recovered reading only in the catalog.
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        updatedAt: UPDATED_AT,
        model: null,
      });
      // A corrupt projection with the recovered reading only in the catalog.
      const brokenDir = path.join(unifiedRoot, OTHER_SESSION_ID, "generations", "0000000000000001");
      yield* fileSystem.makeDirectory(brokenDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(unifiedRoot, OTHER_SESSION_ID, "CURRENT"),
        JSON.stringify({ generation: "0000000000000001", session_id: OTHER_SESSION_ID }),
      );
      yield* fileSystem.writeFileString(path.join(brokenDir, "projection-state.json"), "{invalid");
      yield* writeCatalog(unifiedRoot, [
        {
          sessionId: SESSION_ID,
          fixture: {
            tokenUsage: {
              cachedInputTokens: 10,
              inputTokens: 100,
              outputTokens: 5,
              totalTokens: 105,
            },
            updatedAt: UPDATED_AT + 1_000,
            model: "mistral-large-4",
          },
        },
        {
          sessionId: OTHER_SESSION_ID,
          fixture: {
            tokenUsage: {
              cachedInputTokens: 20,
              inputTokens: 200,
              outputTokens: 7,
              totalTokens: 207,
            },
            updatedAt: UPDATED_AT + 2_000,
            model: "glm-5-3",
          },
        },
      ]);
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      // Both sessions recovered from the catalog, so the scan is complete.
      assert.strictEqual(sources[0]?.status, "ok");
      const records = sources[0]?.files?.flatMap((file) => file.records) ?? [];
      assert.strictEqual(records.length, 2);
      const bySession = new Map(records.map((record) => [record.sessionId, record]));
      assert.strictEqual(bySession.get(SESSION_ID)?.model, "mistral-large-4");
      assert.strictEqual(bySession.get(SESSION_ID)?.timestampMs, UPDATED_AT + 1_000);
      assert.strictEqual(bySession.get(SESSION_ID)?.totals.uncachedInputTokens, 90);
      assert.strictEqual(bySession.get(OTHER_SESSION_ID)?.model, "glm-5-3");
      assert.strictEqual(bySession.get(OTHER_SESSION_ID)?.timestampMs, UPDATED_AT + 2_000);
      assert.strictEqual(bySession.get(OTHER_SESSION_ID)?.totals.uncachedInputTokens, 180);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("marks catalog read failures as partial scans", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        updatedAt: UPDATED_AT,
        model: "mistral-large-4",
      });
      // A corrupt catalog can hide newer journal-backed totals; the scan must
      // say so instead of reporting ok.
      yield* fileSystem.writeFileString(path.join(unifiedRoot, ".session-index.json"), "{invalid");
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      assert.strictEqual(sources[0]?.status, "partial");
      const records = sources[0]?.files?.flatMap((file) => file.records) ?? [];
      assert.deepStrictEqual(
        records.map((record) => record.sessionId),
        [SESSION_ID],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("counts sessions that cannot be stat'ed as unreadable", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeSession(unifiedRoot, SESSION_ID, {
        tokenUsage: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        updatedAt: UPDATED_AT,
        model: "mistral-large-4",
      });
      // A dangling symlink is listed as a session but cannot be stat'ed.
      yield* fileSystem.symlink(
        path.join(unifiedRoot, "gone"),
        path.join(unifiedRoot, OTHER_SESSION_ID),
      );
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      assert.strictEqual(sources[0]?.status, "partial");
      const records = sources[0]?.files?.flatMap((file) => file.records) ?? [];
      assert.deepStrictEqual(
        records.map((record) => record.sessionId),
        [SESSION_ID],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the catalog when a session has no published generation", () =>
    Effect.gen(function* () {
      const { vibeHome, unifiedRoot } = yield* makeVibeHome();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A session directory with no generations on disk, but a journal-backed
      // catalog reading.
      yield* fileSystem.makeDirectory(path.join(unifiedRoot, SESSION_ID), { recursive: true });
      yield* writeCatalog(unifiedRoot, [
        {
          sessionId: SESSION_ID,
          fixture: {
            tokenUsage: {
              cachedInputTokens: 10,
              inputTokens: 100,
              outputTokens: 5,
              totalTokens: 105,
            },
            updatedAt: UPDATED_AT,
            model: "mistral-large-4",
          },
        },
      ]);
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      assert.strictEqual(sources[0]?.status, "ok");
      const files = sources[0]?.files ?? [];
      assert.strictEqual(files.length, 1);
      // No projection file exists, so the session directory is the source path.
      assert.strictEqual(files[0]?.path, path.join(unifiedRoot, SESSION_ID));
      const records = files.flatMap((file) => file.records);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.sessionId, SESSION_ID);
      assert.strictEqual(records[0]?.model, "mistral-large-4");
      assert.strictEqual(records[0]?.timestampMs, UPDATED_AT);
      assert.strictEqual(records[0]?.totals.uncachedInputTokens, 90);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an unreadable session root as a partial scan", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "mistral-vibe-unreadable-test-",
      });
      // A regular file where the vibe home should be: the session root below
      // it cannot be checked, which is not the same as the root missing.
      const vibeHome = path.join(yield* fileSystem.realPath(temp), "blocker");
      yield* fileSystem.writeFileString(vibeHome, "not a directory");
      const sources = yield* scan({
        instances: [
          {
            id: "acpRegistry_mistral_vibe",
            config: decodeSettings({ agentId: "mistral-vibe" }),
            environment: { VIBE_HOME: vibeHome },
          },
        ],
      });
      assert.strictEqual(sources.length, 1);
      assert.strictEqual(sources[0]?.dir, path.join(vibeHome, "logs", "session", "unified"));
      assert.strictEqual(sources[0]?.status, "partial");
      assert.deepStrictEqual(sources[0]?.files, []);
      assert.ok(sources[0]?.message);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
