import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import {
  KimiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { stabilizeKimiProviderProbe } from "../Drivers/KimiDriver.ts";
import { kimiModelStateFromSessionSetup } from "../acp/KimiAcpSupport.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  buildInitialKimiProviderSnapshot,
  buildKimiDiscoveredModelsFromSessionModelState,
  buildKimiModelDiscoveryCacheKey,
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
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(
        decodeKimiSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(decodeKimiSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Kimi");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "k3",
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
      ]);
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
      const settings = decodeKimiSettings({});
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

  it.effect("rediscovers and merges custom models after settings change the cache key", () =>
    Effect.gen(function* () {
      const first = yield* probeKimiProviderStatus(
        decodeKimiSettings({ customModels: ["moonshot-ai/custom-one"] }),
        {},
        { operations: makeProbeOperations() },
      );
      const discoveryCache = first.discoveryCache;
      if (!discoveryCache) {
        throw new Error("healthy probe did not produce a discovery cache");
      }

      const changed = yield* probeKimiProviderStatus(
        decodeKimiSettings({ customModels: ["moonshot-ai/custom-two"] }),
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
      const settings = decodeKimiSettings({});
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
        decodeKimiSettings({}),
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
      const settings = decodeKimiSettings({});
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
      const settings = decodeKimiSettings({});
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
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-version-" });
          const kimiPath = path.join(dir, "kimi");
          yield* fs.writeFileString(
            kimiPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(kimiPath, 0o755);

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

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-success-" });
          const kimiPath = path.join(dir, "kimi");
          yield* fs.writeFileString(
            kimiPath,
            ["#!/bin/sh", 'printf "kimi-cli 1.49.0\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(kimiPath, 0o755);

          return yield* checkKimiProviderStatus(
            decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "k3",
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
      ]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});
