import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  type SecretReference,
} from "@t3tools/contracts";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import { makeProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SecretCheck from "./SecretCheck.ts";

const reference: SecretReference = {
  provider: SecretProviderId.make("work"),
  reference: "op://Private/OpenAI/api-key",
};

const run = (value: string | undefined) =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const layer = SecretCheck.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(SecretResolver.SecretResolver)({
            invalidate: () => Effect.sync(() => void calls.push("invalidate")),
            read: () => Effect.sync(() => (calls.push("read"), [value])),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            applySecretAndRefresh: () => Effect.sync(() => (calls.push("apply"), [])),
          }),
        ),
      ),
    );
    const result = yield* SecretCheck.SecretCheck.use((check) => check.check(reference)).pipe(
      Effect.provide(layer),
    );
    return { result, calls };
  });

it.effect(
  "a readable secret resolves without returning its value and applies it to providers",
  () =>
    Effect.gen(function* () {
      const { result, calls } = yield* run("sk-live-value");
      assert.deepStrictEqual(result, { _tag: "Resolved" });
      assert.deepStrictEqual(calls, ["invalidate", "read", "apply"]);
      assert.notInclude(JSON.stringify(result), "sk-live-value");
    }),
);

it.effect("an unreadable secret fails with the provider named and applies nothing", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* run(undefined);
    assert.strictEqual(result._tag, "Failed");
    if (result._tag === "Failed") assert.include(result.detail, '"work"');
    assert.deepStrictEqual(calls, ["invalidate", "read"]);
  }),
);

const FAKE_KIND = SecretProviderKind.make("fake");

it.effect(
  "applies a check to the instances that read the secret, whatever a second read would return",
  () =>
    Effect.gen(function* () {
      const store = new Map<string, Array<string | undefined>>();
      const reads: Array<string> = [];
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
          Effect.sync(() =>
            references.map((reference) => {
              reads.push(reference);
              const answers = store.get(reference) ?? [];
              return answers.length > 1 ? answers.shift() : answers[0];
            }),
          ),
      });
      const provider = SecretProviderId.make("personal");
      const wanted: SecretReference = { provider, reference: "fake://wanted" };
      const other: SecretReference = { provider, reference: "fake://other" };
      store.set(wanted.reference, [undefined]);
      store.set(other.reference, ["other-key"]);

      const driverKind = ProviderDriverKind.make("fake-provider");
      const dependent = ProviderInstanceId.make("dependent");
      const unrelated = ProviderInstanceId.make("unrelated");
      const driver: AnyProviderDriver = {
        driverKind,
        metadata: { displayName: "Fake" },
        configSchema: Schema.Unknown,
        defaultConfig: () => ({}),
        create: (input) =>
          Effect.succeed({
            instanceId: input.instanceId,
            enabled: input.enabled,
          } as ProviderInstance),
      };
      const instanceConfig = (secret: SecretReference) => ({
        driver: driverKind,
        config: {},
        environment: [{ name: "API_KEY", value: secret, sensitive: true }],
      });

      const resolverLayer = SecretResolver.layer({
        drivers: [secretDriver],
        secretProviders: Effect.succeed({
          [provider]: { kind: FAKE_KIND, label: "Personal", config: {} },
        }),
      }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

      yield* Effect.gen(function* () {
        const resolver = yield* SecretResolver.SecretResolver;
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: { [dependent]: instanceConfig(wanted), [unrelated]: instanceConfig(other) },
        });
        const changes = yield* registry.subscribeChanges;
        yield* PubSub.take(changes);
        assert.deepStrictEqual(
          (yield* registry.listUnavailable).map((entry) => entry.instanceId),
          [dependent],
        );

        // Unlocked for the check's read only: any later read of it would fail again.
        store.set(wanted.reference, ["wanted-key", undefined]);
        const readsBefore = reads.length;
        const result = yield* SecretCheck.SecretCheck.use((check) => check.check(wanted)).pipe(
          Effect.provide(
            SecretCheck.layer.pipe(
              Layer.provide(
                Layer.mock(ProviderRegistry.ProviderRegistry)({
                  applySecretAndRefresh: (reference) =>
                    mutator.applySecret(reference).pipe(Effect.as([])),
                }),
              ),
              Layer.provideMerge(Layer.succeed(SecretResolver.SecretResolver, resolver)),
            ),
          ),
        );

        assert.deepStrictEqual(result, { _tag: "Resolved" });
        assert.deepStrictEqual(
          (yield* registry.listInstances).map((instance) => instance.instanceId).sort(),
          [dependent, unrelated],
        );
        assert.deepStrictEqual(yield* registry.listUnavailable, []);
        assert.deepStrictEqual(reads.slice(readsBefore), [wanted.reference]);
      }).pipe(Effect.provide(resolverLayer), Effect.scoped);
    }),
);
