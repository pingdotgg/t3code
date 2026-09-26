import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { ProviderRegistryLive } from "./Layers/ProviderRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import * as Schema from "effect/Schema";
import {
  applyProviderCompatibility,
  ProviderCompatibilityPolicy,
  resolveProviderCompatibility,
} from "./providerCompatibility.ts";

const driver = ProviderDriverKind.make("codex");
const policy: ProviderCompatibilityPolicy = {
  driver,
  t3CodeRange: ">=0.0.42 <0.1.0",
  recommendedVersion: "2.0.0",
  recommendedRange: ">=2.0.0 <3.0.0",
  ranges: [
    { range: "<1.0.0", status: "broken" },
    { range: ">=1.0.0 <1.5.0", status: "unsupported" },
    { range: ">=1.5.0 <2.0.0", status: "graceful" },
    { range: ">=2.0.0 <3.0.0", status: "supported" },
  ],
};
const provider: ServerProvider = {
  driver,
  instanceId: ProviderInstanceId.make("codex-work"),
  enabled: true,
  installed: true,
  version: "0.9.0",
  status: "error",
  message: "Authentication failed",
  checkedAt: "2026-09-22T00:00:00Z",
  auth: { status: "unauthenticated" },
  models: [],
  skills: [],
  slashCommands: [],
};

describe("provider compatibility", () => {
  it("bundles a compatibility policy for every built-in harness", () => {
    for (const builtIn of BUILT_IN_DRIVERS) {
      // Registry entries are arbitrary external ACP agents, not one versioned harness.
      if (builtIn.driverKind === "acpRegistry") continue;
      assert.isDefined(
        resolveProviderCompatibility(
          ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
          builtIn.driverKind,
          null,
        ),
        `Missing bundled compatibility policy for ${builtIn.driverKind}`,
      );
    }
  });

  it("supports Codex 0.156 and marks Codex without Thread.projectId broken", () => {
    const bundled = ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility;
    for (const [t3CodeVersion, codexVersion, expected] of [
      ["0.0.42", "0.148.0", "broken"],
      ["0.0.42", "0.149.0", "unsupported"],
      ["0.0.42", "0.155.0", "unsupported"],
      ["0.0.42", "0.156.0", "supported"],
      ["0.0.43-nightly.20260924.2200", "0.153.3", "unsupported"],
      ["0.0.43-nightly.20260924.2200", "0.156.1", "supported"],
    ] as const) {
      assert.strictEqual(
        resolveProviderCompatibility(bundled, driver, codexVersion, t3CodeVersion)?.status,
        expected,
        `T3 Code ${t3CodeVersion} with Codex ${codexVersion}`,
      );
    }
  });

  it("compares Cursor build dates without treating semver prereleases as stable", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const cursorPolicy: ProviderCompatibilityPolicy = {
      driver: cursor,
      t3CodeRange: policy.t3CodeRange,
      ranges: [
        { range: "<2026.05.09", status: "unsupported" },
        { range: ">=2026.05.09", status: "supported" },
      ],
    };
    for (const [version, expected] of [
      ["2026.05.08-a1b2c3d", "unsupported"],
      ["2026.05.09-a1b2c3d", "supported"],
      ["2026.09.22-f2b0fcd", "supported"],
      ["2026.05.09", "supported"],
      ["2026.05.09-beta.1", "unknown"],
    ] as const) {
      assert.strictEqual(
        resolveProviderCompatibility([cursorPolicy], cursor, version)?.status,
        expected,
      );
    }
    assert.strictEqual(
      resolveProviderCompatibility([policy], driver, "2.0.0-a1b2c3d")?.status,
      "unknown",
    );
  });

  it("recognizes Antigravity semver release tags while keeping dated candidates unknown", () => {
    const antigravity = ProviderDriverKind.make("antigravity");
    const taggedPolicy = {
      ...policy,
      driver: antigravity,
      ranges: [{ range: "=2.0.0", status: "supported" as const }],
    };
    for (const [version, expected] of [
      ["agy_acp_server_2.0.0", "supported"],
      ["2.0.0", "supported"],
      ["agy_acp_server_2.0.1", "unknown"],
      ["agy_acp_server_2.0.0-beta.1", "unknown"],
      ["agy_acp_server_20260818_01_RC01", "unknown"],
    ] as const) {
      assert.strictEqual(
        resolveProviderCompatibility([taggedPolicy], antigravity, version)?.status,
        expected,
      );
    }
  });

  it("classifies boundaries and treats unlisted versions and release tags as unknown", () => {
    for (const [version, expected] of [
      ["0.9.9", "broken"],
      ["1.0.0", "unsupported"],
      ["1.5.0", "graceful"],
      ["2.0.0", "supported"],
      ["v2.0.0", "supported"],
      ["3.0.0", "unknown"],
      ["2.0.0-beta.1", "unknown"],
      ["agy_acp_server_20260818_01_RC01", "unknown"],
      [null, "unknown"],
    ] as const) {
      assert.strictEqual(resolveProviderCompatibility([policy], driver, version)?.status, expected);
    }
    assert.isUndefined(resolveProviderCompatibility([policy], driver, "0.9.0", "0.1.0"));
  });

  it("supports every driver without inventing policies for uncovered adapters", () => {
    for (const kind of [
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "antigravity",
      "customDriver",
    ]) {
      const adapter = ProviderDriverKind.make(kind);
      assert.strictEqual(
        resolveProviderCompatibility([{ ...policy, driver: adapter }], adapter, "2.0.0")?.status,
        "supported",
      );
      assert.isUndefined(resolveProviderCompatibility([], adapter, "2.0.0"));
    }
  });

  it("relaxes remote policy without losing probe errors, and falls back when a policy is omitted", () => {
    const broken = applyProviderCompatibility(provider, [], [policy]);
    assert.strictEqual(broken.compatibilityAdvisory?.status, "broken");
    const relaxed = { ...policy, ranges: [{ range: ">=0.0.0", status: "supported" as const }] };
    const supported = applyProviderCompatibility(broken, [relaxed], [policy]);
    assert.strictEqual(supported.compatibilityAdvisory?.status, "supported");
    assert.strictEqual(supported.status, "error");
    assert.strictEqual(supported.message, "Authentication failed");
    assert.strictEqual(
      applyProviderCompatibility(supported, [{ ...policy, t3CodeRange: ">=9.0.0" }], [policy])
        .compatibilityAdvisory?.status,
      "broken",
    );
    const removed = applyProviderCompatibility(supported, [], []);
    assert.isUndefined(removed.compatibilityAdvisory);
    assert.strictEqual(removed.status, "error");
    assert.strictEqual(removed.message, "Authentication failed");
    assert.isUndefined(
      applyProviderCompatibility({ ...broken, enabled: false }, [], [policy]).compatibilityAdvisory,
    );
    assert.isUndefined(
      applyProviderCompatibility({ ...broken, installed: false }, [], [policy])
        .compatibilityAdvisory,
    );
  });

  it("rejects invalid ranges and recommendations outside the first supported match", () => {
    const decode = Schema.decodeUnknownSync(ProviderCompatibilityPolicy);
    assert.doesNotThrow(() => decode(policy));
    const prefixed = decode({
      ...policy,
      t3CodeRange: ">=v0.0.42 <v0.1",
      recommendedRange: "^v2",
      ranges: [{ range: ">=v2.0 <v3", status: "supported" }],
    });
    assert.strictEqual(
      resolveProviderCompatibility([prefixed], driver, "2.0.0")?.status,
      "supported",
    );
    assert.strictEqual(
      resolveProviderCompatibility([prefixed], driver, "3.0.0")?.status,
      "unknown",
    );
    for (const invalid of [
      { ...policy, t3CodeRange: "*" },
      { ...policy, recommendedVersion: "3.0.0" },
      { ...policy, ranges: [{ range: ">=2.0.0 garbage", status: "supported" }] },
      { ...policy, recommendedVersion: "2.0.0; echo unsafe" },
      { ...policy, ranges: [{ range: ">=0.0.0", status: "broken" }, ...policy.ranges] },
    ])
      assert.throws(() => decode(invalid));
  });
});

it.effect("a remote policy refresh preserves a newer health result on the registry stream", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const health = yield* Ref.make<ServerProvider>({
      ...provider,
      status: "ready" as ServerProvider["status"],
      message: "Healthy",
    });
    const manifest = yield* Ref.make<ModelManifest.ModelManifestData>({
      version: 1,
      currentModels: {},
      compatibility: [policy],
    });
    const instance: ProviderInstance = {
      instanceId: provider.instanceId,
      driverKind: driver,
      enabled: true,
      displayName: undefined,
      continuationIdentity: { driverKind: driver, continuationKey: "test-codex" },
      snapshot: {
        getSnapshot: Ref.get(health),
        refresh: Ref.get(health),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
          ),
      },
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    };
    const refresh = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(
        Ref.updateAndGet(manifest, (current) => ({
          ...current,
          compatibility: [
            { ...policy, ranges: [{ range: ">=0.0.0", status: "supported" as const }] },
          ],
        })),
      ),
    );
    const dependencies = Layer.mergeAll(
      Layer.succeed(ModelManifest.ModelManifest, {
        current: Ref.get(manifest),
        refresh,
        forceRefresh: refresh,
        refreshInBackground: Effect.void,
      }),
      Layer.succeed(ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "compatibility-registry-test" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry;
      yield* Deferred.await(started);
      assert.strictEqual(
        (yield* registry.getProviders)[0]?.compatibilityAdvisory?.status,
        "broken",
      );
      yield* Ref.set(health, provider);
      const latestHealth = yield* registry.refreshInstance(provider.instanceId);
      assert.strictEqual(latestHealth[0]?.message, "Authentication failed");
      const supported = yield* Stream.toPull(
        registry.streamChanges.pipe(
          Stream.filter((snapshots) => snapshots[0]?.compatibilityAdvisory?.status === "supported"),
        ),
      );
      const subscribed = yield* supported.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const updated = (yield* Fiber.join(subscribed))[0]?.[0];
      assert.strictEqual(updated?.compatibilityAdvisory?.status, "supported");
      assert.strictEqual(updated?.status, "error");
      assert.strictEqual(updated?.message, "Authentication failed");
    }).pipe(Effect.provide(ProviderRegistryLive.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.scoped),
);

it("recomputes latest-version compatibility without losing the underlying update advisory", () => {
  const snapshot: ServerProvider = {
    ...provider,
    version: "2.0.0",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "2.0.0",
      latestVersion: "4.0.0",
      canUpdate: true,
      updateCommand: "npm install -g fixture@latest",
      checkedAt: provider.checkedAt,
      message: null,
    },
  };
  const blockedPolicy: ProviderCompatibilityPolicy = {
    ...policy,
    ranges: [...policy.ranges, { range: ">=3.0.0", status: "broken" }],
  };
  const blocked = applyProviderCompatibility(snapshot, [blockedPolicy], []);
  assert.strictEqual(blocked.compatibilityAdvisory?.latestVersionStatus, "broken");
  const relaxed = applyProviderCompatibility(
    blocked,
    [{ ...policy, ranges: [{ range: ">=2.0.0", status: "supported" }] }],
    [],
  );
  assert.strictEqual(relaxed.compatibilityAdvisory?.latestVersionStatus, "supported");
  assert.deepStrictEqual(relaxed.versionAdvisory, snapshot.versionAdvisory);
});
