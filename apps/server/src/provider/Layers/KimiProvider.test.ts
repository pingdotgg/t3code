import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  KimiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  resolveKimiDriverBinaryPath,
  runKimiProbeWithActiveTurnDeferral,
  stabilizeKimiProviderProbe,
} from "../Drivers/KimiDriver.ts";
import { kimiModelStateFromSessionSetup, makeKimiTurnActivity } from "../acp/KimiAcpSupport.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  buildInitialKimiProviderSnapshot,
  buildKimiDiscoveredModelsFromSessionModelState,
  buildKimiModelDiscoveryCacheKey,
  buildKimiThinkingCapabilitiesFromConfigOptions,
  checkKimiProviderStatus,
  probeKimiProviderStatus,
  type KimiAcpProbeResult,
  type KimiProviderProbeOperations,
  type KimiVersionProbeResult,
} from "./KimiProvider.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const discoveredModels = buildKimiDiscoveredModelsFromSessionModelState({
  currentModelId: "k3",
  availableModels: [{ modelId: "k3", name: "K3" }],
});
const dynamicModelSession = {
  sessionId: "session-1",
  configOptions: [
    {
      id: "available-model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "kimi-code/k3",
      options: [
        { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
        { value: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Coding Highspeed" },
        { value: "kimi-code/k3", name: "K3" },
        { value: "kimi-code/k3-256k", name: "K3-256k" },
        { value: "moonshot-ai/kimi-k3", name: "kimi-k3" },
        { value: "moonshot-ai/kimi-k2.7-code-highspeed", name: "kimi-k2.7-code-highspeed" },
        { value: "moonshot-ai/kimi-k2.7-code", name: "kimi-k2.7-code" },
        { value: "moonshot-ai/kimi-k2.5", name: "kimi-k2.5" },
        { value: "moonshot-ai/kimi-k2.6", name: "kimi-k2.6" },
      ],
    },
  ],
} satisfies EffectAcpSchema.NewSessionResponse;

function thinkingConfigOptions(
  values: ReadonlyArray<string>,
  currentValue: string,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return [
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue,
      options: values.map((value) => ({ value, name: value.toUpperCase() })),
    },
  ];
}

function makeProbeOperations(
  input: {
    readonly version?: KimiVersionProbeResult;
    readonly authentication?: KimiAcpProbeResult<void>;
    readonly discovery?: KimiAcpProbeResult<ReadonlyArray<ServerProviderModel>>;
  } = {},
): KimiProviderProbeOperations {
  return {
    probeVersion: () =>
      Effect.succeed(
        input.version ?? {
          _tag: "success",
          version: "0.37.2",
          resolvedBinaryPath: "C:\\Users\\test\\.kimi-code\\bin\\kimi.exe",
        },
      ),
    probeAuthentication: () =>
      Effect.succeed(input.authentication ?? { _tag: "success", value: undefined }),
    discoverModels: () =>
      Effect.succeed(input.discovery ?? { _tag: "success", value: discoveredModels }),
  };
}

function stampTestProvider(snapshot: ServerProviderDraft): ServerProvider {
  return {
    ...snapshot,
    instanceId: ProviderInstanceId.make("kimi"),
    driver: ProviderDriverKind.make("kimi"),
  };
}

describe("buildInitialKimiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default (opt-in like sibling ACP providers)", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(decodeKimiSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(
        decodeKimiSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Kimi");
      expect(snapshot.showInteractionModeToggle).toBe(true);
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "k3",
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("Kimi driver probe controls", (it) => {
  it.effect("prefers explicit paths, then the official installer, then PATH", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-home-" });
        const fallbackHomeDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3code-kimi-home-fallback-",
        });
        const officialDirectory = path.join(homeDirectory, ".kimi-code", "bin");
        const officialBinaryPath = path.join(officialDirectory, "kimi.exe");
        yield* fs.makeDirectory(officialDirectory, { recursive: true });
        yield* fs.writeFileString(officialBinaryPath, "fixture");

        const explicitBinaryPath = "C:\\tools\\custom-kimi.exe";
        expect(
          yield* resolveKimiDriverBinaryPath(
            { binaryPath: explicitBinaryPath },
            { homeDirectory },
          ).pipe(Effect.provideService(HostProcessPlatform, "win32")),
        ).toBe(explicitBinaryPath);
        expect(
          yield* resolveKimiDriverBinaryPath({ binaryPath: "kimi" }, { homeDirectory }).pipe(
            Effect.provideService(HostProcessPlatform, "win32"),
          ),
        ).toBe(officialBinaryPath);
        expect(
          yield* resolveKimiDriverBinaryPath(
            { binaryPath: "kimi" },
            { homeDirectory: fallbackHomeDirectory },
          ).pipe(Effect.provideService(HostProcessPlatform, "win32")),
        ).toBe("kimi");
      }),
    ),
  );

  it.effect("atomically denies probe admission after a turn becomes active", () =>
    Effect.gen(function* () {
      const turnActivity = yield* makeKimiTurnActivity;
      const threadId = ThreadId.make("thread-probe-admission");

      expect(yield* turnActivity.beginProbeIfIdle).toBe(true);
      yield* turnActivity.markActive(threadId);
      expect(yield* turnActivity.beginProbeIfIdle).toBe(false);
      yield* turnActivity.endProbe;
      yield* turnActivity.markIdle(threadId);
      expect(yield* turnActivity.beginProbeIfIdle).toBe(true);
      yield* turnActivity.endProbe;
    }),
  );

  it.effect("defers a probe during an active turn and resumes when the turn settles", () =>
    Effect.gen(function* () {
      const turnActivity = yield* makeKimiTurnActivity;
      const threadId = ThreadId.make("thread-active");
      const probedSnapshot = stampTestProvider({
        ...(yield* buildInitialKimiProviderSnapshot(decodeKimiSettings({ enabled: true }))),
        status: "ready",
        auth: { status: "authenticated" },
        message: "probe completed",
      });
      const probeStarted = yield* Deferred.make<void>();
      yield* turnActivity.markActive(threadId);

      const probeFiber = yield* runKimiProbeWithActiveTurnDeferral({
        turnActivity,
        probe: Deferred.succeed(probeStarted, undefined).pipe(Effect.as(probedSnapshot)),
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(yield* turnActivity.activeCount).toBe(1);
      expect(yield* Deferred.isDone(probeStarted)).toBe(false);
      yield* turnActivity.markIdle(threadId);
      expect(yield* Fiber.join(probeFiber)).toBe(probedSnapshot);
      expect(yield* Deferred.isDone(probeStarted)).toBe(true);
      expect(yield* turnActivity.activeCount).toBe(0);
    }),
  );
});

describe("buildKimiDiscoveredModelsFromSessionModelState", () => {
  it("returns nothing for an absent or empty model state", () => {
    expect(buildKimiDiscoveredModelsFromSessionModelState(undefined)).toEqual([]);
    expect(
      buildKimiDiscoveredModelsFromSessionModelState({
        currentModelId: "k3",
        availableModels: [],
      }),
    ).toEqual([]);
  });

  it("builds every model advertised by the category-based config option", () => {
    const models = buildKimiDiscoveredModelsFromSessionModelState(
      kimiModelStateFromSessionSetup(dynamicModelSession),
    );

    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["kimi-for-coding", "K2.7 Coding"],
      ["kimi-for-coding-highspeed", "K2.7 Coding Highspeed"],
      ["k3", "K3"],
      ["k3-256k", "K3-256k"],
      ["moonshot-ai/kimi-k3", "kimi-k3"],
      ["moonshot-ai/kimi-k2.7-code-highspeed", "kimi-k2.7-code-highspeed"],
      ["moonshot-ai/kimi-k2.7-code", "kimi-k2.7-code"],
      ["moonshot-ai/kimi-k2.5", "kimi-k2.5"],
      ["moonshot-ai/kimi-k2.6", "kimi-k2.6"],
    ]);
    expect(models.find((model) => model.slug === "k3")?.isDefault).toBe(true);
  });

  it("builds model-specific thinking descriptors only from advertised values", () => {
    const k3Capabilities = buildKimiThinkingCapabilitiesFromConfigOptions(
      thinkingConfigOptions(["low", "high", "max"], "high"),
    );
    const k27Capabilities = buildKimiThinkingCapabilitiesFromConfigOptions(
      thinkingConfigOptions(["on", "high"], "high"),
    );
    const configurableCapabilities = buildKimiThinkingCapabilitiesFromConfigOptions(
      thinkingConfigOptions(["off", "on", "high"], "high"),
    );

    expect(k3Capabilities.optionDescriptors?.[0]).toMatchObject({
      id: "thinking",
      label: "Thinking",
      type: "select",
      currentValue: "high",
      options: [
        { id: "low", label: "LOW" },
        { id: "high", label: "HIGH", isDefault: true },
        { id: "max", label: "MAX" },
      ],
    });
    expect(
      k27Capabilities.optionDescriptors?.[0]?.type === "select"
        ? k27Capabilities.optionDescriptors[0].options.map((option) => option.id)
        : [],
    ).toEqual(["on", "high"]);
    expect(
      configurableCapabilities.optionDescriptors?.[0]?.type === "select"
        ? configurableCapabilities.optionDescriptors[0].options.map((option) => option.id)
        : [],
    ).toEqual(["off", "on", "high"]);

    const models = buildKimiDiscoveredModelsFromSessionModelState(
      kimiModelStateFromSessionSetup(dynamicModelSession),
      new Map([
        ["kimi-code/k3", k3Capabilities],
        ["kimi-code/kimi-for-coding", k27Capabilities],
      ]),
    );
    expect(models.find((model) => model.slug === "k3")?.capabilities).toEqual(k3Capabilities);
    expect(models.find((model) => model.slug === "kimi-for-coding")?.capabilities).toEqual(
      k27Capabilities,
    );
  });

  it("collapses thinking variants onto their base model and marks the current default", () => {
    const models = buildKimiDiscoveredModelsFromSessionModelState({
      currentModelId: "k3,thinking",
      availableModels: [
        { modelId: "k3", name: "K3" },
        { modelId: "k3,thinking", name: "K3 (Thinking)" },
        { modelId: "kimi-for-coding", name: "Kimi K2.7 Code" },
      ],
    });

    expect(models.map((model) => model.slug)).toEqual(["k3", "kimi-for-coding"]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[1]?.isDefault).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("probeKimiProviderStatus", (it) => {
  it.effect("classifies a first healthy probe and reuses its discovery cache", () =>
    Effect.gen(function* () {
      const settings = decodeKimiSettings({ enabled: true });
      const first = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          operations: makeProbeOperations(),
        },
      );
      expect(first.classification).toEqual({ _tag: "healthy", modelSource: "discovery" });
      expect(first.snapshot.status).toBe("ready");
      expect(first.snapshot.auth.status).toBe("authenticated");
      expect(first.discoveryCache).toBeDefined();

      const cache = first.discoveryCache;
      if (!cache) {
        throw new Error("healthy probe did not produce a discovery cache");
      }
      const second = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          discoveryCache: cache,
          operations: {
            ...makeProbeOperations(),
            discoverModels: () => Effect.die("discovery should not run on a cache hit"),
          },
        },
      );
      expect(second.classification).toEqual({ _tag: "healthy", modelSource: "cache" });
      expect(second.snapshot.status).toBe("ready");
      expect(second.snapshot.models.map((model) => model.slug)).toEqual(["k3"]);
    }),
  );

  it.effect("does not cache an empty model discovery result", () =>
    Effect.gen(function* () {
      const settings = decodeKimiSettings({ enabled: true });
      const empty = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          operations: makeProbeOperations({ discovery: { _tag: "success", value: [] } }),
        },
      );

      expect(empty.classification).toEqual({ _tag: "healthy", modelSource: "discovery" });
      expect(empty.discoveryCache).toBeUndefined();
      expect(empty.snapshot.models.map((model) => model.slug)).toEqual([
        "k3",
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
      ]);

      const retry = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          operations: makeProbeOperations(),
        },
      );
      expect(retry.classification).toEqual({ _tag: "healthy", modelSource: "discovery" });
      expect(retry.discoveryCache?.models).toEqual(discoveredModels);
    }),
  );

  it.effect("rediscovers and merges custom models after settings change the cache key", () =>
    Effect.gen(function* () {
      const first = yield* probeKimiProviderStatus(
        decodeKimiSettings({ enabled: true, customModels: ["moonshot-ai/custom-one"] }),
        {},
        { operations: makeProbeOperations() },
      );
      const discoveryCache = first.discoveryCache;
      if (!discoveryCache) {
        throw new Error("healthy probe did not produce a discovery cache");
      }

      const changed = yield* probeKimiProviderStatus(
        decodeKimiSettings({ enabled: true, customModels: ["moonshot-ai/custom-two"] }),
        {},
        {
          discoveryCache,
          operations: {
            ...makeProbeOperations(),
            probeAuthentication: () => Effect.die("stale cache must not be authenticated"),
          },
        },
      );
      expect(changed.classification).toEqual({ _tag: "healthy", modelSource: "discovery" });
      expect(changed.snapshot.models.map((model) => model.slug)).toEqual([
        "k3",
        "moonshot-ai/custom-two",
      ]);
    }),
  );

  it.effect("keys model discovery by version, resolved binary, home, and settings", () =>
    Effect.sync(() => {
      const settings = decodeKimiSettings({
        binaryPath: "kimi",
        homePath: "~/.kimi-code-one",
        customModels: ["custom-one"],
      });
      const base = buildKimiModelDiscoveryCacheKey({
        version: "0.37.2",
        resolvedBinaryPath: "C:\\Kimi\\kimi.exe",
        kimiSettings: settings,
      });
      expect(
        buildKimiModelDiscoveryCacheKey({
          version: "0.37.3",
          resolvedBinaryPath: "C:\\Kimi\\kimi.exe",
          kimiSettings: settings,
        }),
      ).not.toBe(base);
      expect(
        buildKimiModelDiscoveryCacheKey({
          version: "0.37.2",
          resolvedBinaryPath: "D:\\Kimi\\kimi.exe",
          kimiSettings: settings,
        }),
      ).not.toBe(base);
      expect(
        buildKimiModelDiscoveryCacheKey({
          version: "0.37.2",
          resolvedBinaryPath: "C:\\Kimi\\kimi.exe",
          kimiSettings: decodeKimiSettings({
            binaryPath: "kimi",
            homePath: "~/.kimi-code-two",
            customModels: ["custom-two"],
          }),
        }),
      ).not.toBe(base);
    }),
  );

  it.effect("keeps command-missing, non-zero, and auth-required outcomes distinct", () =>
    Effect.gen(function* () {
      const settings = decodeKimiSettings({ enabled: true });
      const commandMissing = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          operations: makeProbeOperations({ version: { _tag: "command-missing" } }),
        },
      );
      expect(commandMissing.classification).toEqual({ _tag: "command-missing" });
      expect(commandMissing.snapshot.installed).toBe(false);

      const nonZero = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          operations: makeProbeOperations({
            version: { _tag: "non-zero-exit", exitCode: 2, version: "0.37.2" },
          }),
        },
      );
      expect(nonZero.classification).toEqual({ _tag: "non-zero-exit", exitCode: 2 });
      expect(nonZero.snapshot.installed).toBe(true);
      expect(nonZero.snapshot.auth.status).toBe("unknown");

      const authRequired = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          operations: makeProbeOperations({ discovery: { _tag: "auth-required" } }),
        },
      );
      expect(authRequired.classification).toEqual({ _tag: "auth-required" });
      expect(authRequired.snapshot.auth.status).toBe("unauthenticated");

      const acpFailure = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          operations: makeProbeOperations({
            discovery: { _tag: "failure", errorTag: "AcpProtocolParseError" },
          }),
        },
      );
      expect(acpFailure.classification).toEqual({
        _tag: "acp-failure",
        stage: "discovery",
        errorTag: "AcpProtocolParseError",
      });
      expect(acpFailure.snapshot.status).toBe("error");
    }),
  );

  it.effect("uses a non-destructive warning for a first transient timeout", () =>
    Effect.gen(function* () {
      const result = yield* probeKimiProviderStatus(
        decodeKimiSettings({ enabled: true }),
        {},
        {
          operations: makeProbeOperations({
            version: { _tag: "transient-timeout", timeoutMs: 10_000 },
          }),
        },
      );
      expect(result.classification).toEqual({
        _tag: "transient-timeout",
        stage: "version",
        timeoutMs: 10_000,
      });
      expect(result.snapshot.status).toBe("warning");
      expect(result.snapshot.auth.status).toBe("unknown");
    }),
  );

  it.effect("retains a healthy snapshot across three transient refresh cycles", () =>
    Effect.gen(function* () {
      const settings = decodeKimiSettings({ enabled: true });
      const healthy = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          operations: makeProbeOperations(),
        },
      );
      const lastKnownGoodRef = yield* Ref.make<ServerProvider | null>(null);
      yield* stabilizeKimiProviderProbe(lastKnownGoodRef, {
        ...healthy,
        snapshot: stampTestProvider(healthy.snapshot),
      });

      const transientCycles: ReadonlyArray<KimiVersionProbeResult> = [
        { _tag: "transient-timeout", timeoutMs: 10_000 },
        { _tag: "transient-process-failure", errorTag: "AcpTransportError" },
        { _tag: "transient-timeout", timeoutMs: 10_000 },
      ];
      for (const version of transientCycles) {
        const transient = yield* probeKimiProviderStatus(
          settings,
          {},
          {
            operations: makeProbeOperations({ version }),
          },
        );
        const snapshot = yield* stabilizeKimiProviderProbe(lastKnownGoodRef, {
          ...transient,
          snapshot: stampTestProvider(transient.snapshot),
        });
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
      }
    }),
  );

  it.effect("does not mask auth loss with the last healthy snapshot", () =>
    Effect.gen(function* () {
      const settings = decodeKimiSettings({ enabled: true });
      const lastKnownGoodRef = yield* Ref.make<ServerProvider | null>(null);
      const healthy = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          operations: makeProbeOperations(),
        },
      );
      yield* stabilizeKimiProviderProbe(lastKnownGoodRef, {
        ...healthy,
        snapshot: stampTestProvider(healthy.snapshot),
      });
      const discoveryCache = healthy.discoveryCache;
      if (!discoveryCache) {
        throw new Error("healthy probe did not produce a discovery cache");
      }
      const authRequired = yield* probeKimiProviderStatus(
        settings,
        {},
        {
          discoveryCache,
          operations: makeProbeOperations({ authentication: { _tag: "auth-required" } }),
        },
      );
      const snapshot = yield* stabilizeKimiProviderProbe(lastKnownGoodRef, {
        ...authRequired,
        snapshot: stampTestProvider(authRequired.snapshot),
      });
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(yield* Ref.get(lastKnownGoodRef)).toBeNull();
    }),
  );
});

it.layer(NodeServices.layer)("checkKimiProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKimiProviderStatus(
        decodeKimiSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/kimi-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken kimi install: secret-token-value";
      const platform = yield* HostProcessPlatform;
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-version-" });
          const kimiPath = path.join(dir, platform === "win32" ? "kimi.cmd" : "kimi");
          yield* fs.writeFileString(
            kimiPath,
            platform === "win32"
              ? ["@echo off", `echo ${secretStderr} 1>&2`, "exit /b 2"].join("\r\n")
              : ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2"].join("\n"),
          );
          if (platform !== "win32") {
            yield* fs.chmod(kimiPath, 0o755);
          }

          return yield* checkKimiProviderStatus(
            decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Kimi CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports a transient warning when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-acp-" });
          const kimiPath = path.join(dir, platform === "win32" ? "kimi.cmd" : "kimi");
          yield* fs.writeFileString(
            kimiPath,
            platform === "win32"
              ? [
                  "@echo off",
                  'if "%~1"=="--version" (',
                  "  echo kimi-cli 1.49.0",
                  "  exit /b 0",
                  ")",
                  "echo not-json",
                  "exit /b 0",
                ].join("\r\n")
              : [
                  "#!/bin/sh",
                  'if [ "$1" = "--version" ]; then',
                  '  printf "kimi-cli 1.49.0\\n"',
                  "  exit 0",
                  "fi",
                  'printf "not-json\\n"',
                  "exit 0",
                ].join("\n"),
          );
          if (platform !== "win32") {
            yield* fs.chmod(kimiPath, 0o755);
          }
          return yield* checkKimiProviderStatus(
            decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "k3",
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
      ]);
      expect(snapshot.message).toContain("failed temporarily");
    }),
  );
});
