import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { beforeEach } from "vite-plus/test";

import { OpenCodeSettings } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  resolveOpenCodeServerPassword,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import {
  checkOpenCodeProviderStatus,
  openCodeCommandsToServerProviderSlashCommands,
} from "./OpenCodeProvider.ts";
import type { OpenCodeInventory } from "../opencodeRuntime.ts";
import { readOpenCodeGoUsageLimits } from "./openCodeUsageLimits.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";

it.effect("reads Go limits with the instance's XDG credentials and preserves reset times", () =>
  Effect.gen(function* () {
    const resetsAt = "2026-09-17T12:00:00.000Z";
    const limits = yield* readOpenCodeGoUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { XDG_DATA_HOME: "/instance/data", OPENCODE_API_KEY: "env-key" },
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            NodeAssert.equal(path, "/instance/data/opencode/auth.json");
            return Effect.succeed(
              JSON.stringify({ "opencode-go": { type: "api", key: "instance-key" } }),
            );
          },
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          NodeAssert.equal(request.url, "https://opencode.ai/zen/go/v1/usage");
          NodeAssert.equal(request.headers.authorization, "Bearer instance-key");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                usage: {
                  rolling: { percent: 0, resetsAt },
                  weekly: { percent: 10, resetsAt },
                  monthly: { percent: 125, resetsAt },
                },
              }),
            ),
          );
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(limits.unavailable, undefined);
    NodeAssert.deepEqual(
      limits.windows.map(({ kind, usedPercent, resetsAt: reset }) => ({
        kind,
        usedPercent,
        reset,
      })),
      [
        { kind: "session", usedPercent: 0, reset: resetsAt },
        { kind: "weekly", usedPercent: 10, reset: resetsAt },
        { kind: "monthly", usedPercent: 100, reset: resetsAt },
      ],
    );
  }),
);

it.effect("does not read local credentials for external or disabled OpenCode instances", () =>
  Effect.gen(function* () {
    for (const settings of [
      { enabled: true, serverUrl: "https://remote.example" },
      { enabled: false, serverUrl: "" },
    ]) {
      const limits = yield* readOpenCodeGoUsageLimits({ ...settings, environment: {} }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("unexpected credential read"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected usage request")),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, "unsupported");
    }
  }),
);

it.effect("keeps Go entitlement absence distinct from failed or malformed usage responses", () =>
  Effect.gen(function* () {
    for (const [status, reason] of [
      [403, "unsupported"],
      [401, "probeFailed"],
      [200, "probeFailed"],
    ] as const) {
      const limits = yield* readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          OPENCODE_AUTH_CONTENT: '{"opencode-go":{"type":"api","key":"inline-key"}}',
        },
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("inline credentials must bypass disk"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status }))),
          ),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, reason);
      NodeAssert.deepEqual(limits.windows, []);
    }
  }),
);

/**
 * The legacy `OpenCodeProviderLive` Layer + `OpenCodeProvider` service tag
 * are deleted. The snapshot-producing logic they wrapped now lives in the
 * standalone `checkOpenCodeProviderStatus(settings, cwd)` Effect, which
 * drivers call directly when building their per-instance snapshot
 * `ServerProviderShape`. Tests mirror that shape: build a settings payload,
 * invoke the check, assert on the returned snapshot.
 */

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    runVersionPending: false,
    versionStdout: DEFAULT_VERSION_STDOUT,
    inventoryError: null as Error | null,
    connectionError: null as Error | null,
    inventoryCwd: null as string | null,
    closeCalls: 0,
    sdkClientInputs: [] as Array<{
      baseUrl: string;
      directory: string;
      serverPassword?: string;
    }>,
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      skills: [] as unknown[],
    } as unknown,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.runVersionPending = false;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.inventoryError = null;
    this.state.connectionError = null;
    this.state.inventoryCwd = null;
    this.state.closeCalls = 0;
    this.state.sdkClientInputs.length = 0;
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      skills: [] as unknown[],
    };
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ serverPassword, environment }) =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls += 1;
        }),
      );
      const effectiveServerPassword = resolveOpenCodeServerPassword({
        external: false,
        ...(serverPassword !== undefined ? { serverPassword } : {}),
        ...(environment !== undefined ? { environment } : {}),
      });
      return {
        url: "http://127.0.0.1:4301",
        ...(effectiveServerPassword !== undefined
          ? { serverPassword: effectiveServerPassword }
          : {}),
        version: "1.14.19",
        isRunning: Effect.succeed(true),
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    Effect.gen(function* () {
      if (runtimeMock.state.connectionError) {
        return yield* new OpenCodeRuntimeError({
          operation: "global.health",
          detail: runtimeMock.state.connectionError.message,
          cause: runtimeMock.state.connectionError,
        });
      }
      if (!serverUrl) {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls += 1;
          }),
        );
      }
      return {
        url: serverUrl ?? "http://127.0.0.1:4301",
        ...(serverPassword ? { serverPassword } : {}),
        version: "1.14.19",
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () =>
    runtimeMock.state.runVersionPending
      ? Effect.never
      : runtimeMock.state.runVersionError
        ? Effect.fail(
            new OpenCodeRuntimeError({
              operation: "runOpenCodeCommand",
              detail: runtimeMock.state.runVersionError.message,
              cause: runtimeMock.state.runVersionError,
            }),
          )
        : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
  createOpenCodeSdkClient: (input) => {
    runtimeMock.state.sdkClientInputs.push(input);
    return {} as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>;
  },
  loadOpenCodeInventory: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "loadOpenCodeInventory",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory),
  loadInventoryFromCli: ({ cwd }) => {
    runtimeMock.state.inventoryCwd = cwd;
    return runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "loadInventoryFromCli",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory);
  },
  loadOpenCodeSkills: () => Effect.succeed([]),
  loadSkillsFromCli: () => Effect.succeed([]),
};

beforeEach(() => {
  runtimeMock.reset();
});

it("keeps native and MCP commands while preserving compaction and separate skills", () => {
  NodeAssert.deepEqual(
    openCodeCommandsToServerProviderSlashCommands([
      { name: "review", description: "Review changes", source: "command", hints: ["$ARGUMENTS"] },
      { name: "review", source: "command", hints: [] },
      { name: "compact", source: "command", hints: [] },
      { name: "skill", source: "skill", hints: [] },
      { name: "mcp:search", source: "mcp", hints: ["query"] },
    ]).slice(1),
    [
      { name: "review", description: "Review changes", input: { hint: "$ARGUMENTS" } },
      { name: "mcp:search", input: { hint: "query" } },
    ],
  );
});

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const makeOpenCodeSettings = (overrides?: Partial<OpenCodeSettings>): OpenCodeSettings =>
  decodeOpenCodeSettings({
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

const checkProvider = Effect.fn("checkProvider")(function* (
  settings: OpenCodeSettings,
  cwd = process.cwd(),
  environment?: NodeJS.ProcessEnv,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: settings.binaryPath,
        directory: cwd,
        ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
        ...(environment ? { environment } : {}),
      });
      return yield* checkOpenCodeProviderStatus(settings, cwd, environment).pipe(
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
      );
    }),
  );
});

it.layer(testLayer)("checkOpenCodeProviderStatus", (it) => {
  it.effect("shows a codex-style missing binary message", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode CLI (`opencode`) is not installed or not on PATH.",
      );
    }),
  );

  it.effect("hides generic Effect.tryPromise text for local CLI probe failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("An error occurred in Effect.tryPromise");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.message, "Failed to execute OpenCode CLI health check.");
    }),
  );

  it.effect("times out a hanging local CLI version probe", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionPending = true;
      const probeFiber = yield* checkProvider(makeOpenCodeSettings()).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const snapshot = yield* Fiber.join(probeFiber);

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "Failed to execute OpenCode CLI health check: OpenCode CLI version probe timed out after 10 seconds.",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("emits OpenCode variant defaults so trait picker can resolve a visible selection", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  variants: {
                    none: {},
                    low: {},
                    medium: {},
                    high: {},
                    xhigh: {},
                  },
                },
              },
            },
          ],
          default: {},
        },
        agents: [
          { name: "build", hidden: false, mode: "primary" },
          { name: "plan", hidden: false, mode: "primary" },
        ],
      };

      const snapshot = yield* checkProvider(makeOpenCodeSettings());
      const model = snapshot.models.find((entry) => entry.slug === "openai/gpt-5.4");

      NodeAssert.ok(model);
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      NodeAssert.ok(variantDescriptor && variantDescriptor.type === "select");
      NodeAssert.equal(
        variantDescriptor.options.find((option) => option.isDefault === true)?.id,
        "medium",
      );
      const agentDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "agent" && descriptor.type === "select",
      );
      NodeAssert.ok(agentDescriptor && agentDescriptor.type === "select");
      NodeAssert.equal(
        agentDescriptor.options.find((option) => option.isDefault === true)?.id,
        "build",
      );
    }),
  );

  it.effect("includes OpenCode skills in the provider snapshot", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [],
        skills: [
          {
            name: "openclaw-review",
            description: "Review OpenClaw workflow changes.",
            location: "/Users/test/.agents/skills/openclaw-review/SKILL.md",
          },
          {
            name: "openclaw-triage",
            description: "Triage OpenClaw routing issues.",
            location: "/Users/test/.agents/skills/openclaw-triage/SKILL.md",
          },
          {
            name: "missing-location",
            description: "This incomplete SDK row should be skipped.",
            location: "",
          },
        ],
      };

      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.deepEqual(
        snapshot.skills.map((skill) => ({
          name: skill.name,
          path: skill.path,
          enabled: skill.enabled,
          shortDescription: skill.shortDescription,
        })),
        [
          {
            name: "openclaw-review",
            path: "/Users/test/.agents/skills/openclaw-review/SKILL.md",
            enabled: true,
            shortDescription: "Review OpenClaw workflow changes.",
          },
          {
            name: "openclaw-triage",
            path: "/Users/test/.agents/skills/openclaw-triage/SKILL.md",
            enabled: true,
            shortDescription: "Triage OpenClaw routing issues.",
          },
        ],
      );
    }),
  );

  it.effect("loads local inventory from a scoped OpenCode server", () =>
    Effect.gen(function* () {
      yield* checkProvider(makeOpenCodeSettings({ serverPassword: "secret-password" }));

      NodeAssert.deepEqual(runtimeMock.state.sdkClientInputs, [
        {
          baseUrl: "http://127.0.0.1:4301",
          directory: process.cwd(),
          serverPassword: "secret-password",
        },
      ]);
      NodeAssert.equal(runtimeMock.state.closeCalls, 1);
      NodeAssert.equal(runtimeMock.state.inventoryCwd, null);
    }),
  );

  it.effect("uses an environment-only password for local inventory", () =>
    Effect.gen(function* () {
      yield* checkProvider(makeOpenCodeSettings(), process.cwd(), {
        OPENCODE_SERVER_PASSWORD: "environment-password",
      });

      NodeAssert.deepEqual(runtimeMock.state.sdkClientInputs, [
        {
          baseUrl: "http://127.0.0.1:4301",
          directory: process.cwd(),
          serverPassword: "environment-password",
        },
      ]);
    }),
  );

  it.effect("uses the settings password when local environment auth differs", () =>
    Effect.gen(function* () {
      yield* checkProvider(
        makeOpenCodeSettings({ serverPassword: "settings-password" }),
        process.cwd(),
        { OPENCODE_SERVER_PASSWORD: "environment-password" },
      );

      NodeAssert.equal(runtimeMock.state.sdkClientInputs[0]?.serverPassword, "settings-password");
    }),
  );

  it.effect("reports local model inventory failures without treating them as empty", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("opencode models failed");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.equal(
        snapshot.message,
        "Failed to load OpenCode provider inventory: opencode models failed",
      );
    }),
  );
});

it.layer(testLayer)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect("does not send a local environment password to a configured server", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
        process.cwd(),
        { OPENCODE_SERVER_PASSWORD: "local-secret" },
      );

      NodeAssert.equal(snapshot.version, "1.14.19");
      NodeAssert.deepEqual(runtimeMock.state.sdkClientInputs, [
        {
          baseUrl: "http://127.0.0.1:9999",
          directory: process.cwd(),
        },
      ]);
    }),
  );

  it.effect("rejects an unsupported server before loading inventory", () =>
    Effect.gen(function* () {
      runtimeMock.state.connectionError = new Error(
        "OpenCode v1.14.18 is too old. Upgrade to v1.14.19 or newer.",
      );
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.match(snapshot.message ?? "", /v1\.14\.18 is too old/);
      NodeAssert.equal(runtimeMock.state.sdkClientInputs.length, 0);
    }),
  );

  it.effect("surfaces a friendly auth error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.connectionError = new Error("401 Unauthorized");
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("surfaces a friendly connection error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.connectionError = new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:9999",
      );
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct.",
      );
    }),
  );
});
