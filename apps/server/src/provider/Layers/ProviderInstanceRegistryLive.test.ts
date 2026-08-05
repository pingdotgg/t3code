/**
 * Multi-instance validation slices for `ProviderInstanceRegistryLive`.
 *
 * Two axes of the driver/registry refactor are exercised here:
 *
 *  1. **Same driver, many instances** — the "multi-instance codex slice"
 *     describe block below configures two independent `codex` instances and
 *     asserts each gets its own closures and identity. This is the
 *     multi-codex capability the refactor exists to unlock.
 *
 *  2. **Many drivers, one registry** — the "all drivers slice" describe
 *     block below configures one instance of every shipped driver
 *     (`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`) in a single
 *     `ProviderInstanceConfigMap` and asserts the registry boots them all
 *     without cross-contamination. This proves the driver SPI is uniform
 *     across every provider — any driver plugs into the registry through
 *     the same `ProviderDriver` value contract.
 *
 * Every instance in these tests is configured with `enabled: false` so the
 * provider-status checks short-circuit to pending/disabled snapshots
 * without trying to spawn real `codex` / `claude` / `agent` / `grok` / `opencode`
 * binaries. That keeps the assertions focused on registry routing
 * behaviour rather than the runtime details of each provider.
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClaudeSettings,
  type CodexSettings,
  type CursorSettings,
  type GrokSettings,
  type OpenCodeSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import { GrokDriver } from "../Drivers/GrokDriver.ts";
import { OpenCodeDriver } from "../Drivers/OpenCodeDriver.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  ...overrides,
});

const makeCursorConfig = (overrides: Partial<CursorSettings>): CursorSettings => ({
  enabled: false,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
  ...overrides,
});

const makeGrokConfig = (overrides: Partial<GrokSettings>): GrokSettings => ({
  enabled: false,
  binaryPath: "grok",
  customModels: [],
  ...overrides,
});

const makeOpenCodeConfig = (overrides: Partial<OpenCodeSettings>): OpenCodeSettings => ({
  enabled: false,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
  ...overrides,
});

describe("ProviderInstanceRegistryLive — reconcile lifecycle", () => {
  it.effect("keeps unavailable snapshots visible when replacement is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("shadow_default");
        const unavailableDriverKind = ProviderDriverKind.make("missing");
        const driverKind = ProviderDriverKind.make("test");
        const enteredBlockedCreate = yield* Deferred.make<void>();

        const driver = {
          driverKind,
          metadata: { displayName: "Test" },
          configSchema: Schema.Struct({ version: Schema.String }),
          defaultConfig: () => ({ version: "default" }),
          create: Effect.fn("UnavailableTransitionTestDriver.create")(function* (input) {
            const version = input.config.version;
            if (version === "blocked") {
              yield* Deferred.succeed(enteredBlockedCreate, undefined);
              return yield* Effect.never;
            }
            return {
              instanceId: input.instanceId,
              driverKind,
              continuationIdentity: {
                driverKind,
                continuationKey: `test:${version}`,
              },
              displayName: version,
              enabled: true,
              snapshot: {} as ProviderInstance["snapshot"],
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
          }),
        } satisfies ProviderDriver<{ readonly version: string }>;

        const initialConfig: ProviderInstanceConfigMap = {
          [instanceId]: {
            driver: unavailableDriverKind,
            config: { version: "unavailable" },
          },
        };
        const liveConfig = (version: string): ProviderInstanceConfigMap => ({
          [instanceId]: {
            driver: driverKind,
            config: { version },
          },
        });
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: initialConfig,
        });
        const initialUnavailable = yield* registry.listUnavailable;
        expect(initialUnavailable.map((snapshot) => snapshot.instanceId)).toEqual([instanceId]);

        const interrupted = yield* Effect.forkChild(mutator.reconcile(liveConfig("blocked")));
        yield* Deferred.await(enteredBlockedCreate);
        expect(yield* registry.listUnavailable).toEqual(initialUnavailable);

        yield* Fiber.interrupt(interrupted);
        expect(Exit.hasInterrupts(yield* Fiber.await(interrupted))).toBe(true);
        expect(yield* registry.listUnavailable).toEqual(initialUnavailable);

        yield* mutator.reconcile(liveConfig("recovered"));
        expect(yield* registry.listUnavailable).toEqual([]);
        expect((yield* registry.getInstance(instanceId))?.displayName).toBe("recovered");
      }),
    ),
  );

  it.effect("keeps scope ownership safe when replacement is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("test_default");
        const driverKind = ProviderDriverKind.make("test");
        const enteredInitialClose = yield* Deferred.make<void>();
        const releaseInitialClose = yield* Deferred.make<void>();
        const enteredBlockedCreate = yield* Deferred.make<void>();
        const created = yield* Ref.make<ReadonlyArray<string>>([]);
        const finalized = yield* Ref.make<ReadonlyArray<string>>([]);
        const openScopes = yield* Ref.make(0);

        const driver = {
          driverKind,
          metadata: { displayName: "Test" },
          configSchema: Schema.Struct({ version: Schema.String }),
          defaultConfig: () => ({ version: "default" }),
          create: Effect.fn("InterruptibleTestDriver.create")(function* (input) {
            const version = input.config.version;
            yield* Ref.update(created, (versions) => [...versions, version]);
            yield* Ref.update(openScopes, (count) => count + 1);
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (version === "initial") {
                  yield* Deferred.succeed(enteredInitialClose, undefined);
                  yield* Deferred.await(releaseInitialClose);
                }
                yield* Ref.update(openScopes, (count) => count - 1);
                yield* Ref.update(finalized, (versions) => [...versions, version]);
              }),
            );
            if (version === "blocked-create") {
              yield* Deferred.succeed(enteredBlockedCreate, undefined);
              return yield* Effect.never;
            }
            return {
              instanceId: input.instanceId,
              driverKind,
              continuationIdentity: {
                driverKind,
                continuationKey: `test:${version}`,
              },
              displayName: version,
              enabled: true,
              snapshot: {} as ProviderInstance["snapshot"],
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
          }),
        } satisfies ProviderDriver<{ readonly version: string }>;

        const configMap = (version: string): ProviderInstanceConfigMap => ({
          [instanceId]: {
            driver: driverKind,
            config: { version },
          },
        });
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: configMap("initial"),
        });

        const interruptedClose = yield* Effect.forkChild(
          mutator.reconcile(configMap("not-created")),
        );
        yield* Deferred.await(enteredInitialClose);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();

        yield* Effect.sync(() => interruptedClose.interruptUnsafe());
        expect(interruptedClose.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(releaseInitialClose, undefined);
        expect(Exit.hasInterrupts(yield* Fiber.await(interruptedClose))).toBe(true);
        expect(yield* Ref.get(created)).toEqual(["initial"]);
        expect(yield* Ref.get(finalized)).toEqual(["initial"]);
        expect(yield* Ref.get(openScopes)).toBe(0);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();

        yield* mutator.reconcile(configMap("steady"));
        const interruptedCreate = yield* Effect.forkChild(
          mutator.reconcile(configMap("blocked-create")),
        );
        yield* Deferred.await(enteredBlockedCreate);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();
        expect(yield* Ref.get(openScopes)).toBe(1);

        yield* Fiber.interrupt(interruptedCreate);
        expect(Exit.hasInterrupts(yield* Fiber.await(interruptedCreate))).toBe(true);
        expect(yield* Ref.get(finalized)).toEqual(["initial", "steady", "blocked-create"]);
        expect(yield* Ref.get(openScopes)).toBe(0);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();

        yield* mutator.reconcile(configMap("recovered"));
        expect((yield* registry.getInstance(instanceId))?.displayName).toBe("recovered");
        expect(yield* Ref.get(openScopes)).toBe(1);
      }),
    ),
  );

  it.effect("serializes concurrent replacements and leaves only the newest scope live", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("test_default");
        const driverKind = ProviderDriverKind.make("test");
        const enteredBlockedCreate = yield* Deferred.make<void>();
        const releaseBlockedCreate = yield* Deferred.make<void>();
        const created = yield* Ref.make<ReadonlyArray<string>>([]);
        const finalized = yield* Ref.make<ReadonlyArray<string>>([]);
        const openScopes = yield* Ref.make(0);

        const driver = {
          driverKind,
          metadata: { displayName: "Test" },
          configSchema: Schema.Struct({ version: Schema.String }),
          defaultConfig: () => ({ version: "default" }),
          create: Effect.fn("TestDriver.create")(function* (input) {
            const version = input.config.version;
            yield* Ref.update(created, (versions) => [...versions, version]);
            if (version === "blocked") {
              yield* Deferred.succeed(enteredBlockedCreate, undefined);
              yield* Deferred.await(releaseBlockedCreate);
            }
            yield* Ref.update(openScopes, (count) => count + 1);
            yield* Effect.addFinalizer(() =>
              Ref.update(openScopes, (count) => count - 1).pipe(
                Effect.andThen(Ref.update(finalized, (versions) => [...versions, version])),
              ),
            );
            return {
              instanceId: input.instanceId,
              driverKind,
              continuationIdentity: {
                driverKind,
                continuationKey: `test:${version}`,
              },
              displayName: version,
              enabled: true,
              snapshot: {} as ProviderInstance["snapshot"],
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
          }),
        } satisfies ProviderDriver<{ readonly version: string }>;

        const configMap = (version: string): ProviderInstanceConfigMap => ({
          [instanceId]: {
            driver: driverKind,
            config: { version },
          },
        });
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: configMap("initial"),
        });

        const blocked = yield* Effect.forkChild(mutator.reconcile(configMap("blocked")));
        yield* Deferred.await(enteredBlockedCreate);
        const newest = yield* Effect.forkChild(mutator.reconcile(configMap("newest")));
        yield* Effect.yieldNow;

        expect(yield* Ref.get(created)).toEqual(["initial", "blocked"]);
        yield* Deferred.succeed(releaseBlockedCreate, undefined);
        yield* Fiber.join(blocked);
        yield* Fiber.join(newest);

        expect((yield* registry.getInstance(instanceId))?.displayName).toBe("newest");
        expect(yield* Ref.get(created)).toEqual(["initial", "blocked", "newest"]);
        expect(yield* Ref.get(finalized)).toEqual(["initial", "blocked"]);
        expect(yield* Ref.get(openScopes)).toBe(1);
      }),
    ),
  );
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  // `ServerConfig.layerTest` needs `FileSystem` to materialize its scratch
  // directory. `Layer.merge` just unions requirements, so we have to push
  // `NodeServices.layer` through `Layer.provideMerge` to satisfy that
  // dependency while still surfacing NodeServices to the test body (the
  // codex driver's `create` yields `ChildProcessSpawner` directly).
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");
      const personalHomePath = path.resolve(path.sep, "home", "julius", ".codex_personal");
      const workHomePath = path.resolve(path.sep, "home", "julius", ".codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: personalHomePath,
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: workHomePath,
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      // Each instance must be retrievable by id and carry its *own* closures.
      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.adapter).not.toBe(work!.adapter);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      // Snapshots identify themselves by instanceId + driver — this is
      // what makes per-instance routing distinguishable downstream.
      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      expect(personalSnapshot.continuation?.groupKey).toBe(`codex:home:${personalHomePath}`);

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe(`codex:home:${workHomePath}`);

      // Nothing goes to the unavailable bucket — both drivers are registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      yield* mutator.reconcile(configMap, { force: true });
      const rebuiltPersonal = yield* registry.getInstance(personalId);
      const rebuiltWork = yield* registry.getInstance(workId);
      expect(rebuiltPersonal).not.toBe(personal);
      expect(rebuiltWork).not.toBe(work);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — all drivers slice", () => {
  // All drivers need `NodeServices` (ChildProcessSpawner + FileSystem +
  // Path). `OpenCodeDriver.create` additionally yields `OpenCodeRuntime`
  // at construction time, so we wire `OpenCodeRuntimeLive` into the stack.
  // `OpenCodeRuntimeLive` bundles its own `NetService.layer` via
  // `Layer.provide`, so the only external requirement it still exposes is
  // `ChildProcessSpawner` — resolved here by piping it through
  // `provideMerge(NodeServices.layer)`.
  //
  // The nested `provideMerge`s read bottom-up: `NodeServices.layer`
  // provides `OpenCodeRuntimeLive`'s deps while keeping its own outputs
  // surfaced; that merged layer then provides `ServerConfig.layerTest`'s
  // `FileSystem` dep while keeping everything else surfaced to the test.
  const infraLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-all-drivers-test",
  }).pipe(
    Layer.provideMerge(infraLayer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");
      const cursorId = ProviderInstanceId.make("cursor_default");
      const grokId = ProviderInstanceId.make("grok_default");
      const openCodeId = ProviderInstanceId.make("opencode_default");
      const codexHomePath = path.resolve(path.sep, "home", "julius", ".codex");
      const claudeHomePath = path.resolve(path.sep, "home", "julius", ".claude-work");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
      const cursorDriverKind = ProviderDriverKind.make("cursor");
      const grokDriverKind = ProviderDriverKind.make("grok");
      const openCodeDriverKind = ProviderDriverKind.make("opencode");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: codexHomePath }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: claudeHomePath,
            launchArgs: "--verbose",
          }),
        },
        [cursorId]: {
          driver: cursorDriverKind,
          displayName: "Cursor",
          enabled: false,
          config: makeCursorConfig({}),
        },
        [grokId]: {
          driver: grokDriverKind,
          displayName: "Grok",
          enabled: false,
          config: makeGrokConfig({}),
        },
        [openCodeId]: {
          driver: openCodeDriverKind,
          displayName: "OpenCode",
          enabled: false,
          config: makeOpenCodeConfig({}),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver, ClaudeDriver, CursorDriver, GrokDriver, OpenCodeDriver],
        configMap,
      });

      // Every configured instance must materialize — none downgraded to a
      // shadow snapshot, because every driver in the map is registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(5);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId, cursorId, grokId, openCodeId].toSorted(),
      );

      // Instance lookup by id resolves each instance to its own bundle —
      // this is how rest-of-server routes turn/session calls in the new
      // model. Each driver's bundle carries its advertised `driverKind`.
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      const cursor = yield* registry.getInstance(cursorId);
      const grok = yield* registry.getInstance(grokId);
      const openCode = yield* registry.getInstance(openCodeId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(cursor?.driverKind).toBe(cursorDriverKind);
      expect(grok?.driverKind).toBe(grokDriverKind);
      expect(openCode?.driverKind).toBe(openCodeDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");
      expect(cursor?.displayName).toBe("Cursor");
      expect(grok?.displayName).toBe("Grok");
      expect(openCode?.displayName).toBe("OpenCode");

      // Every instance owns its own set of closures — no sharing across
      // drivers. `adapter` / `textGeneration` / `snapshot` are all
      // distinct references even when two instances happen to share a
      // trait (e.g. Cursor + others all use a stub-or-real
      // `textGeneration`; they must still be different object values).
      const adapters = [
        codex!.adapter,
        claude!.adapter,
        cursor!.adapter,
        grok!.adapter,
        openCode!.adapter,
      ];
      expect(new Set(adapters).size).toBe(adapters.length);
      const textGenerations = [
        codex!.textGeneration,
        claude!.textGeneration,
        cursor!.textGeneration,
        grok!.textGeneration,
        openCode!.textGeneration,
      ];
      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      const snapshots = [
        codex!.snapshot,
        claude!.snapshot,
        cursor!.snapshot,
        grok!.snapshot,
        openCode!.snapshot,
      ];
      expect(new Set(snapshots).size).toBe(snapshots.length);

      // Snapshots identify themselves by `instanceId` + `driver` so
      // downstream aggregation in `ProviderRegistry` can tell instances
      // apart even when two share a driver. With `enabled: false`, the
      // check short-circuits and we get a disabled/pending snapshot back
      // — that's enough signal to validate the stamping wrapper without
      // spawning real binaries.
      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.continuation?.groupKey).toBe(`codex:home:${codexHomePath}`);

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.continuation?.groupKey).toBe(`claude:home:${claudeHomePath}`);

      const cursorSnapshot = yield* cursor!.snapshot.getSnapshot;
      expect(cursorSnapshot.instanceId).toBe(cursorId);
      expect(cursorSnapshot.driver).toBe(cursorDriverKind);
      expect(cursorSnapshot.enabled).toBe(false);
      expect(cursorSnapshot.continuation?.groupKey).toBe(
        `${cursorDriverKind}:instance:${cursorId}`,
      );

      const grokSnapshot = yield* grok!.snapshot.getSnapshot;
      expect(grokSnapshot.instanceId).toBe(grokId);
      expect(grokSnapshot.driver).toBe(grokDriverKind);
      expect(grokSnapshot.enabled).toBe(false);
      expect(grokSnapshot.continuation?.groupKey).toBe(`${grokDriverKind}:instance:${grokId}`);

      const openCodeSnapshot = yield* openCode!.snapshot.getSnapshot;
      expect(openCodeSnapshot.instanceId).toBe(openCodeId);
      expect(openCodeSnapshot.driver).toBe(openCodeDriverKind);
      expect(openCodeSnapshot.enabled).toBe(false);
      expect(openCodeSnapshot.continuation?.groupKey).toBe(
        `${openCodeDriverKind}:instance:${openCodeId}`,
      );
    }).pipe(Effect.provide(testLayer)),
  );
});
