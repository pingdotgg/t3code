import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  codexCustomEndpoint,
  codexRoutesSpendNativeQuota,
  makeCodexSkillsProbe,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

function makeFakeCodexAppServers() {
  const helpers: Array<{
    readonly codexHome: unknown;
    readonly crash: Effect.Effect<void>;
    readonly requests: Array<unknown>;
    closed: boolean;
  }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const crash = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(1)).pipe(
        Effect.andThen(Queue.end(output)),
        Effect.asVoid,
      );
      const helper = {
        codexHome: command._tag === "StandardCommand" ? command.options.env?.CODEX_HOME : undefined,
        crash,
        requests: [] as Array<unknown>,
        closed: false,
      };
      helpers.push(helper);
      yield* Effect.addFinalizer(() => Effect.sync(() => (helper.closed = true)));
      const respond = (id: unknown, result: unknown) =>
        Queue.offer(output, new TextEncoder().encode(`${JSON.stringify({ id, result })}\n`));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_000 + helpers.length),
        exitCode: Deferred.await(exited),
        isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
        kill: () => crash,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: string | Uint8Array) =>
          Effect.forEach(
            (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
              .split("\n")
              .filter(Boolean),
            (line) => {
              const frame = JSON.parse(line) as {
                readonly id?: number;
                readonly method: string;
                readonly params?: { readonly cwds: ReadonlyArray<string> };
              };
              if (frame.id === undefined) return Effect.void;
              if (frame.method === "initialize") {
                return respond(frame.id, {
                  codexHome: "/codex-home",
                  platformFamily: "unix",
                  platformOs: "linux",
                  userAgent: "codex/0.0.0",
                });
              }
              helper.requests.push(frame.params);
              return respond(frame.id, {
                data: (frame.params?.cwds ?? []).map((cwd) => ({
                  cwd,
                  errors: [],
                  skills: [
                    {
                      name: `skill-in-${cwd}`,
                      path: `${cwd}/SKILL.md`,
                      enabled: true,
                      description: "",
                      scope: "repo",
                    },
                  ],
                })),
              });
            },
            { discard: true },
          ),
        ),
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { helpers, spawner };
}

it.effect("reuses one Codex skills helper per launch until it idles out", () =>
  Effect.gen(function* () {
    const { helpers, spawner } = makeFakeCodexAppServers();
    const providerScope = yield* Scope.make();
    const probe = yield* makeCodexSkillsProbe().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Scope.provide(providerScope),
    );
    const read = (cwd: string, homePath = "/home-a") =>
      probe({ binaryPath: "codex", homePath, cwd, environment: {} }).pipe(
        Effect.map((skills) => skills.map((skill) => skill.name)),
      );

    assert.deepStrictEqual(yield* read("/alpha"), ["skill-in-/alpha"]);
    assert.deepStrictEqual(yield* read("/beta"), ["skill-in-/beta"]);
    assert.strictEqual(helpers.length, 1);
    assert.deepStrictEqual(helpers[0]!.requests, [
      { cwds: ["/alpha"], forceReload: true },
      { cwds: ["/beta"], forceReload: true },
    ]);

    // Another home is another launch identity; the previous helper retires at once.
    assert.deepStrictEqual(yield* read("/alpha", "/home-b"), ["skill-in-/alpha"]);
    assert.strictEqual(helpers.length, 2);
    assert.strictEqual(helpers[0]!.closed, true);
    assert.strictEqual(helpers[1]!.codexHome, "/home-b");

    // A helper that exits is replaced within the same read.
    yield* helpers[1]!.crash;
    assert.deepStrictEqual(yield* read("/beta", "/home-b"), ["skill-in-/beta"]);
    assert.strictEqual(helpers.length, 3);

    yield* TestClock.adjust("29 seconds");
    assert.strictEqual(helpers[2]!.closed, false);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(helpers[2]!.closed, true);
    assert.deepStrictEqual(yield* read("/alpha", "/home-b"), ["skill-in-/alpha"]);
    assert.strictEqual(helpers.length, 4);

    yield* Scope.close(providerScope, Exit.void);
    assert.strictEqual(helpers[3]!.closed, true);
  }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] },
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
    {
      id: "cyberAccessProgram",
      label: "Cyber Access",
      type: "select",
      options: [
        { id: "standard", label: "Standard", isDefault: true },
        { id: "daybreakBlue", label: "Daybreak Blue" },
      ],
      currentValue: "standard",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("reports native quota only for an OpenAI login on a native route", () => {
  const chatgpt = { type: "chatgpt", email: "a@example.com", planType: "pro" } as const;
  const hub = {
    model_provider: "hub",
    model_providers: { hub: { base_url: "https://hub.example.com/v1" } },
  };
  const cases = [
    ["default route", chatgpt, true, {}, true],
    ["openai base url", chatgpt, true, { openai_base_url: "https://chatgpt.com/x" }, true],
    ["openai proxy url", chatgpt, true, { openai_base_url: "https://proxy.example.com" }, false],
    ["custom provider", chatgpt, true, hub, false],
    ["unknown provider id", chatgpt, true, { model_provider: "missing" }, false],
    ["unreadable config", chatgpt, true, null, false],
    ["login not required", chatgpt, false, {}, false],
    ["api key", { type: "apiKey" }, true, {}, false],
  ] as const;
  for (const [name, account, requiresOpenaiAuth, config, expected] of cases) {
    assert.strictEqual(
      codexRoutesSpendNativeQuota({ account, requiresOpenaiAuth }, config),
      expected,
      name,
    );
  }
  // The custom endpoint is what a usage-limit hub is matched against.
  assert.strictEqual(codexCustomEndpoint(hub), "https://hub.example.com");
  assert.strictEqual(
    codexCustomEndpoint({ openai_base_url: "http://127.0.0.1:8317/v1" }),
    "http://127.0.0.1:8317",
  );
  assert.strictEqual(codexCustomEndpoint({ openai_base_url: "https://chatgpt.com/x" }), undefined);
  assert.strictEqual(codexCustomEndpoint({}), undefined);
});

function writeCodexBackfillState(dbPath: string, status: string, updatedAt: number): void {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS backfill_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        last_watermark TEXT,
        last_success_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO backfill_state (id, status, last_watermark, last_success_at, updated_at)
       VALUES (1, ?, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    ).run(status, updatedAt);
  } finally {
    db.close();
  }
}

function readCodexBackfillStatus(dbPath: string): string | undefined {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT status FROM backfill_state WHERE id = 1").get();
    return typeof row?.status === "string" ? row.status : undefined;
  } finally {
    db.close();
  }
}

function makeHangingCodexProbeSpawner(onSpawn?: () => void) {
  let closed = false;
  const started = Deferred.makeUnsafe<void>();
  const closedDeferred = Deferred.makeUnsafe<void>();
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      onSpawn?.();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
        }).pipe(Effect.andThen(Deferred.succeed(closedDeferred, undefined)), Effect.asVoid),
      );
      yield* Deferred.succeed(started, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_100),
        exitCode: Effect.never,
        isRunning: Effect.sync(() => !closed),
        kill: () =>
          Effect.sync(() => {
            closed = true;
          }).pipe(Effect.andThen(Deferred.succeed(closedDeferred, undefined)), Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.never,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return {
    spawner,
    started: Deferred.await(started),
    awaitClosed: Deferred.await(closedDeferred),
    isClosed: () => closed,
  };
}

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

const TEST_EPOCH_SEC = 1_700_000_000;

it.effect(
  "keeps codex app-server alive until an owned state db backfill finishes after probe timeout",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(TEST_EPOCH_SEC * 1000);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-backfill-" });
      const dbPath = path.join(tempHome, "state_5.sqlite");

      const { spawner, started, awaitClosed, isClosed } = makeHangingCodexProbeSpawner(() => {
        writeCodexBackfillState(dbPath, "running", TEST_EPOCH_SEC);
      });

      const fiber = yield* checkCodexProviderStatus(
        decodeCodexSettings({ homePath: tempHome }),
        undefined,
        {},
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkChild,
      );

      yield* started;
      yield* TestClock.adjust("20 seconds");
      const status = yield* Fiber.join(fiber);

      assert.strictEqual(status.status, "error");
      assert.match(status.message ?? "", /backfilling its local state database/);
      assert.strictEqual(isClosed(), false);

      // Once Codex completes backfill, the detached probe process closes cleanly.
      writeCodexBackfillState(dbPath, "complete", TEST_EPOCH_SEC + 25);
      yield* TestClock.adjust("1 second");
      yield* awaitClosed;
      assert.strictEqual(isClosed(), true);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "linux"),
    ),
);

it.effect("releases a stale backfill claim so the probe can take over and finish it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(TEST_EPOCH_SEC * 1000);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-stale-backfill-" });
    const dbPath = path.join(tempHome, "state_5.sqlite");
    writeCodexBackfillState(dbPath, "running", TEST_EPOCH_SEC - 60);

    let statusAtSpawn: string | undefined;
    const { spawner, started, awaitClosed, isClosed } = makeHangingCodexProbeSpawner(() => {
      statusAtSpawn = readCodexBackfillStatus(dbPath);
      // Codex only claims a "running" row once its 15-minute lease has expired.
      if (statusAtSpawn !== "running") {
        writeCodexBackfillState(dbPath, "running", TEST_EPOCH_SEC);
      }
    });
    const fiber = yield* checkCodexProviderStatus(
      decodeCodexSettings({ homePath: tempHome }),
      undefined,
      {},
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkChild,
    );

    yield* started;
    yield* TestClock.adjust("20 seconds");
    const status = yield* Fiber.join(fiber);

    assert.strictEqual(statusAtSpawn, "pending");
    assert.strictEqual(status.status, "error");
    assert.match(status.message ?? "", /backfilling its local state database/);
    assert.strictEqual(isClosed(), false);

    writeCodexBackfillState(dbPath, "complete", TEST_EPOCH_SEC + 45);
    yield* TestClock.adjust("1 second");
    yield* awaitClosed;
    assert.strictEqual(isClosed(), true);
  }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcess.Platform, "linux")),
);

it.effect(
  "closes a hung probe immediately with the default message when no backfill is running",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(TEST_EPOCH_SEC * 1000);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-hung-probe-" });
      writeCodexBackfillState(path.join(tempHome, "state_5.sqlite"), "complete", TEST_EPOCH_SEC);

      const { spawner, started, isClosed } = makeHangingCodexProbeSpawner();
      const fiber = yield* checkCodexProviderStatus(
        decodeCodexSettings({ homePath: tempHome }),
        undefined,
        {},
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkChild,
      );

      yield* started;
      yield* TestClock.adjust("20 seconds");
      const status = yield* Fiber.join(fiber);

      assert.strictEqual(status.status, "error");
      assert.strictEqual(
        status.message,
        "Timed out while checking Codex app-server provider status.",
      );
      assert.strictEqual(isClosed(), true);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "linux"),
    ),
);

it.effect("inspects CODEX_SQLITE_HOME when the state database lives outside CODEX_HOME", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(TEST_EPOCH_SEC * 1000);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-home-" });
    const sqliteHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-sqlite-" });
    const dbPath = path.join(sqliteHome, "state_5.sqlite");

    const { spawner, started, awaitClosed, isClosed } = makeHangingCodexProbeSpawner(() => {
      writeCodexBackfillState(dbPath, "running", TEST_EPOCH_SEC);
    });

    const fiber = yield* checkCodexProviderStatus(
      decodeCodexSettings({ homePath: codexHome }),
      undefined,
      { CODEX_SQLITE_HOME: sqliteHome },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkChild,
    );

    yield* started;
    yield* TestClock.adjust("20 seconds");
    const status = yield* Fiber.join(fiber);

    assert.strictEqual(status.status, "error");
    assert.match(status.message ?? "", /backfilling its local state database/);
    assert.strictEqual(isClosed(), false);

    writeCodexBackfillState(dbPath, "complete", TEST_EPOCH_SEC + 25);
    yield* TestClock.adjust("1 second");
    yield* awaitClosed;
    assert.strictEqual(isClosed(), true);
  }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcess.Platform, "linux")),
);

it.effect("prefers config.toml sqlite_home over CODEX_SQLITE_HOME", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(TEST_EPOCH_SEC * 1000);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-home-" });
    const configSqliteHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-cfg-sqlite-" });
    const envSqliteHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-env-sqlite-" });
    yield* fs.writeFileString(
      path.join(codexHome, "config.toml"),
      `sqlite_home = ${JSON.stringify(configSqliteHome)}\n`,
    );
    const dbPath = path.join(configSqliteHome, "state_5.sqlite");

    const { spawner, started, awaitClosed, isClosed } = makeHangingCodexProbeSpawner(() => {
      writeCodexBackfillState(dbPath, "running", TEST_EPOCH_SEC);
    });

    const fiber = yield* checkCodexProviderStatus(
      decodeCodexSettings({ homePath: codexHome }),
      undefined,
      { CODEX_SQLITE_HOME: envSqliteHome },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkChild,
    );

    yield* started;
    yield* TestClock.adjust("20 seconds");
    const status = yield* Fiber.join(fiber);

    assert.strictEqual(status.status, "error");
    assert.match(status.message ?? "", /backfilling its local state database/);
    assert.strictEqual(isClosed(), false);

    writeCodexBackfillState(dbPath, "complete", TEST_EPOCH_SEC + 25);
    yield* TestClock.adjust("1 second");
    yield* awaitClosed;
    assert.strictEqual(isClosed(), true);
  }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcess.Platform, "linux")),
);

it.effect("parses quoted sqlite_home launch args with spaces", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(TEST_EPOCH_SEC * 1000);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-home-" });
    const configSqliteHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-cfg-sqlite-" });
    const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-cli-sqlite-" });
    const cliSqliteHome = path.join(parentDir, "codex state dir");
    yield* fs.makeDirectory(cliSqliteHome, { recursive: true });
    yield* fs.writeFileString(
      path.join(codexHome, "config.toml"),
      `sqlite_home = ${JSON.stringify(configSqliteHome)}\n`,
    );
    const dbPath = path.join(cliSqliteHome, "state_5.sqlite");

    const { spawner, started, awaitClosed, isClosed } = makeHangingCodexProbeSpawner(() => {
      writeCodexBackfillState(dbPath, "running", TEST_EPOCH_SEC);
    });

    const fiber = yield* checkCodexProviderStatus(
      decodeCodexSettings({
        homePath: codexHome,
        launchArgs: `-c "sqlite_home=${cliSqliteHome}"`,
      }),
      undefined,
      { CODEX_SQLITE_HOME: configSqliteHome },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkChild,
    );

    yield* started;
    yield* TestClock.adjust("20 seconds");
    const status = yield* Fiber.join(fiber);

    assert.strictEqual(status.status, "error");
    assert.match(status.message ?? "", /backfilling its local state database/);
    assert.strictEqual(isClosed(), false);

    writeCodexBackfillState(dbPath, "complete", TEST_EPOCH_SEC + 25);
    yield* TestClock.adjust("1 second");
    yield* awaitClosed;
    assert.strictEqual(isClosed(), true);
  }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcess.Platform, "linux")),
);

it.effect("decodes TOML escapes in config.toml sqlite_home", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(TEST_EPOCH_SEC * 1000);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-home-" });
    const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-toml-sqlite-" });
    const escapedSqliteHome = path.join(parentDir, "codex state");
    yield* fs.makeDirectory(escapedSqliteHome, { recursive: true });
    const tomlEscaped = `${parentDir.replace(/\\/g, "\\\\")}/codex\\u0020state`;
    yield* fs.writeFileString(
      path.join(codexHome, "config.toml"),
      `sqlite_home = "${tomlEscaped}"\n`,
    );
    const dbPath = path.join(escapedSqliteHome, "state_5.sqlite");

    const { spawner, started, awaitClosed, isClosed } = makeHangingCodexProbeSpawner(() => {
      writeCodexBackfillState(dbPath, "running", TEST_EPOCH_SEC);
    });

    const fiber = yield* checkCodexProviderStatus(
      decodeCodexSettings({ homePath: codexHome }),
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkChild,
    );

    yield* started;
    yield* TestClock.adjust("20 seconds");
    const status = yield* Fiber.join(fiber);

    assert.strictEqual(status.status, "error");
    assert.match(status.message ?? "", /backfilling its local state database/);
    assert.strictEqual(isClosed(), false);

    writeCodexBackfillState(dbPath, "complete", TEST_EPOCH_SEC + 25);
    yield* TestClock.adjust("1 second");
    yield* awaitClosed;
    assert.strictEqual(isClosed(), true);
  }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcess.Platform, "linux")),
);
