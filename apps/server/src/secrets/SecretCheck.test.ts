import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  type SecretReference,
  SettingsSecretValue,
  type ServerProvider,
} from "@t3tools/contracts";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SecretCheck from "./SecretCheck.ts";

const FAKE_KIND = SecretProviderKind.make("fake");
const secretProvider = SecretProviderId.make("personal");
const wanted: SecretReference = { provider: secretProvider, reference: "fake://wanted" };
const other: SecretReference = { provider: secretProvider, reference: "fake://other" };
const locked: SecretReference = { provider: secretProvider, reference: "fake://locked" };
const driverKind = ProviderDriverKind.make("fake-provider");
const dependent = ProviderInstanceId.make("dependent");
const unrelated = ProviderInstanceId.make("unrelated");

const providerSnapshot = (instanceId: ProviderInstanceId): ServerProvider => ({
  instanceId,
  driver: driverKind,
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-03T00:00:00.000Z",
  version: "1.0.0",
  models: [],
  slashCommands: [],
  skills: [],
});

/**
 * A server whose `dependent` instance reads `dependentReads` and `unrelated` reads `other`, all
 * through the real resolver, instance registry and provider registry. `vault` answers each read of
 * a reference with the next queued value, repeating the last one, after `beforeRead`.
 */
const setup = Effect.fn("SecretCheckTest.setup")(function* (
  vault: Map<string, Array<string | undefined>>,
  dependentReads: ReadonlyArray<SecretReference> = [wanted],
  options: {
    readonly dependentConfig?: unknown;
    readonly beforeRead?: (reference: string) => Effect.Effect<void>;
  } = {},
) {
  const reads: Array<string> = [];
  const created: Array<{ instanceId: ProviderInstanceId; secrets: ReadonlyArray<unknown> }> = [];
  const createdConfigs: Array<unknown> = [];
  const refreshed: Array<ProviderInstanceId> = [];

  const secretDriver = defineSecretProviderDriver({
    kind: FAKE_KIND,
    definition: defineSecretProvider({
      kind: FAKE_KIND,
      label: "Fake",
      configSchema: Schema.Struct({}),
      isReference: (value) => value.startsWith("fake://"),
      referencePlaceholder: "fake://item",
      invalidReferenceMessage: "Use fake://item.",
    }),
    read: (_config, references) =>
      Effect.forEach(references, (reference) =>
        (options.beforeRead?.(reference) ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              reads.push(reference);
              const answers = vault.get(reference) ?? [];
              return answers.length > 1 ? answers.shift() : answers[0];
            }),
          ),
        ),
      ),
  });

  const driver: AnyProviderDriver = {
    driverKind,
    metadata: { displayName: "Fake" },
    configSchema: Schema.Struct({
      keys: Schema.Record(Schema.String, SettingsSecretValue).pipe(
        Schema.withDecodingDefault(Effect.succeed({})),
      ),
    }),
    defaultConfig: () => ({}),
    create: (input) =>
      Effect.sync(() => {
        created.push({
          instanceId: input.instanceId,
          secrets: input.environment.map((variable) => variable.value),
        });
        createdConfigs.push(input.config);
        const snapshot = providerSnapshot(input.instanceId);
        return {
          instanceId: input.instanceId,
          driverKind,
          continuationIdentity: { driverKind, continuationKey: `fake:${input.instanceId}` },
          displayName: undefined,
          enabled: input.enabled,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driverKind,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(snapshot),
            refresh: Effect.sync(() => {
              refreshed.push(input.instanceId);
              return snapshot;
            }),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
      }),
  };
  const instanceConfig = (secrets: ReadonlyArray<SecretReference>, config: unknown = {}) => ({
    driver: driverKind,
    config,
    environment: secrets.map((secret, index) => ({
      name: `API_KEY_${index}`,
      value: secret,
      sensitive: true,
    })),
  });

  const resolverContext = yield* Layer.build(
    SecretResolver.layer({
      drivers: [secretDriver],
      secretProviders: Effect.succeed({
        [secretProvider]: { kind: FAKE_KIND, label: "Personal", config: {} },
      }),
    }),
  );
  const { registry, mutator } = yield* ProviderInstanceRegistry.makeProviderInstanceRegistry({
    drivers: [driver],
    configMap: {
      [dependent]: instanceConfig(dependentReads, options.dependentConfig),
      [unrelated]: instanceConfig([other]),
    },
  }).pipe(Effect.provide(resolverContext));
  // Secrets are read after startup, so wait for the change that applies them.
  const changes = yield* registry.subscribeChanges;
  yield* PubSub.take(changes);

  const services = yield* Layer.build(
    SecretCheck.layer.pipe(
      Layer.provideMerge(ProviderRegistry.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(resolverContext),
          Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, registry),
          Layer.succeed(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  );
  const secretCheck = yield* SecretCheck.SecretCheck.pipe(Effect.provide(services));
  const resolver = yield* SecretResolver.SecretResolver.pipe(Effect.provide(resolverContext));
  return { secretCheck, registry, mutator, resolver, reads, created, createdConfigs, refreshed };
});

const layerTest = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-check-" }),
  ModelManifest.layerTest,
  ProviderLatestVersions.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
    ),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.layer(layerTest)("SecretCheck", (it) => {
  it.effect(
    "a readable secret rebuilds and refreshes only the instances that read it, from that one read",
    () =>
      Effect.gen(function* () {
        const vault = new Map<string, Array<string | undefined>>([
          [wanted.reference, [undefined]],
          [other.reference, ["other-key"]],
        ]);
        const server = yield* setup(vault);
        assert.deepStrictEqual(
          (yield* server.registry.listUnavailable).map((entry) => entry.instanceId),
          [dependent],
        );
        const createdBefore = server.created.length;
        const readsBefore = server.reads.length;

        // Unlocked for the check's own read only: any second read would fail again.
        vault.set(wanted.reference, ["wanted-key", undefined]);
        const result = yield* server.secretCheck.check(wanted);

        assert.deepStrictEqual(result, { _tag: "Resolved" });
        assert.notInclude(JSON.stringify(result), "wanted-key");
        assert.deepStrictEqual(server.reads.slice(readsBefore), [wanted.reference]);
        assert.deepStrictEqual(server.created.slice(createdBefore), [
          { instanceId: dependent, secrets: ["wanted-key"] },
        ]);
        assert.deepStrictEqual(server.refreshed, [dependent]);
        assert.deepStrictEqual(yield* server.registry.listUnavailable, []);
      }),
  );

  it.effect("an unreadable secret fails naming its provider and leaves instances alone", () =>
    Effect.gen(function* () {
      const vault = new Map<string, Array<string | undefined>>([
        [wanted.reference, [undefined]],
        [other.reference, ["other-key"]],
      ]);
      const server = yield* setup(vault);
      const createdBefore = server.created.length;

      const result = yield* server.secretCheck.check(wanted);

      assert.strictEqual(result._tag, "Failed");
      if (result._tag === "Failed") assert.include(result.detail, "Personal");
      assert.deepStrictEqual(server.created.slice(createdBefore), []);
      assert.deepStrictEqual(server.refreshed, []);
      assert.deepStrictEqual(
        (yield* server.registry.listUnavailable).map((entry) => entry.instanceId),
        [dependent],
      );
    }),
  );

  it.effect("a failed check keeps the value the server already holds", () =>
    Effect.gen(function* () {
      const vault = new Map<string, Array<string | undefined>>([
        [wanted.reference, ["wanted-key"]],
        [locked.reference, ["locked-key", undefined]],
        [other.reference, ["other-key"]],
      ]);
      const server = yield* setup(vault, [wanted, locked]);
      const readsBefore = server.reads.length;

      assert.strictEqual((yield* server.secretCheck.check(locked))._tag, "Failed");

      assert.deepStrictEqual(yield* server.resolver.read([locked]), ["locked-key"]);
      assert.deepStrictEqual(server.reads.slice(readsBefore), [locked.reference]);
    }),
  );

  it.effect("a check applies to an instance whose other secret failed a later refresh", () =>
    Effect.gen(function* () {
      const vault = new Map<string, Array<string | undefined>>([
        [wanted.reference, ["wanted-old"]],
        [locked.reference, ["locked-key", undefined]],
        [other.reference, ["other-key"]],
      ]);
      const server = yield* setup(vault, [wanted, locked]);
      // A Settings refresh while the vault is locked keeps the live instance and caches the failure.
      yield* server.mutator.reloadSecrets(dependent);
      vault.set(wanted.reference, ["wanted-new"]);

      assert.deepStrictEqual(yield* server.secretCheck.check(wanted), { _tag: "Resolved" });

      assert.deepStrictEqual(server.created.at(-1), {
        instanceId: dependent,
        secrets: ["wanted-new", "locked-key"],
      });
      assert.deepStrictEqual(yield* server.registry.listUnavailable, []);
    }),
  );

  it.effect("a check applies the value it read when a refresh re-reads that secret first", () =>
    Effect.forEach(
      // A live instance holding the old value, and one parked on a locked vault.
      ["wanted-old", undefined],
      (initial) =>
        Effect.gen(function* () {
          const vault = new Map<string, Array<string | undefined>>([
            [wanted.reference, [initial]],
            [other.reference, ["other-key"]],
          ]);
          const readStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let gate: Effect.Effect<void> = Effect.void;
          const server = yield* setup(vault, [wanted], {
            beforeRead: () => {
              const current = gate;
              gate = Effect.void;
              return current;
            },
          });
          // The check reads the rotated value; the refresh's read after it finds the vault locked.
          vault.set(wanted.reference, ["wanted-new", undefined]);
          gate = Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          );

          const check = yield* server.secretCheck
            .check(wanted)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(readStarted);
          // The refresh takes the registry lock, then waits on the resolver for the check's read.
          const refresh = yield* server.mutator
            .reloadSecrets(dependent)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(release, undefined);

          assert.deepStrictEqual(yield* Fiber.join(check), { _tag: "Resolved" });
          yield* Fiber.join(refresh);
          assert.deepStrictEqual(server.created.at(-1), {
            instanceId: dependent,
            secrets: ["wanted-new"],
          });
          assert.deepStrictEqual(yield* server.registry.listUnavailable, []);
        }).pipe(Effect.scoped),
      { discard: true },
    ),
  );

  it.effect("a check replaces only its own key of a record-valued config secret", () =>
    Effect.gen(function* () {
      const vault = new Map<string, Array<string | undefined>>([
        [wanted.reference, ["wanted-old"]],
        [locked.reference, ["locked-key"]],
        [other.reference, ["other-key"]],
      ]);
      const server = yield* setup(vault, [], {
        dependentConfig: { keys: { a: wanted, b: locked } },
      });
      vault.set(wanted.reference, ["wanted-new"]);

      assert.deepStrictEqual(yield* server.secretCheck.check(wanted), { _tag: "Resolved" });

      assert.deepStrictEqual(server.created.at(-1), { instanceId: dependent, secrets: [] });
      assert.deepStrictEqual(server.createdConfigs.at(-1), {
        keys: { a: "wanted-new", b: "locked-key" },
      });
    }),
  );
});
