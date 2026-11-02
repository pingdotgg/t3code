import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  SecretProviderId,
  SecretProviderKind,
  type SecretReference,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { defineSecretProviderDriver } from "./driver.ts";
import * as SecretResolver from "./SecretResolver.ts";
import { defineSecretProvider } from "../shared/definition.ts";

const FAKE_KIND = SecretProviderKind.make("fake");
const FakeConfig = Schema.Struct({ account: Schema.String });

const personal = SecretProviderId.make("personal");
const work = SecretProviderId.make("work");
const fake = (account: string) => ({
  kind: FAKE_KIND,
  label: account,
  config: { account },
});
const ref = (reference: string, provider = personal): SecretReference => ({ provider, reference });

function fakeDriver(
  answer: (account: string, reference: string) => string | undefined,
  wait: (references: ReadonlyArray<string>) => Effect.Effect<void> = () => Effect.void,
) {
  const reads: Array<{ readonly account: string; readonly references: ReadonlyArray<string> }> = [];
  const driver = defineSecretProviderDriver({
    kind: FAKE_KIND,
    definition: defineSecretProvider({
      kind: FAKE_KIND,
      label: "Fake",
      configSchema: FakeConfig,
      isReference: (reference) => reference.startsWith("fake://"),
      referencePlaceholder: "fake://item",
      invalidReferenceMessage: "Use fake://item.",
    }),
    read: ({ account }, references) =>
      wait(references).pipe(
        Effect.andThen(
          Effect.sync(() => {
            reads.push({ account, references });
            return references.map((reference) => answer(account, reference));
          }),
        ),
      ),
  });
  return { driver, reads };
}

const resolverLayer = (
  driver: ReturnType<typeof fakeDriver>["driver"],
  secretProviders: () => ServerSettings["secretProviders"] = () => ({ [personal]: fake("a") }),
) =>
  SecretResolver.layer({
    drivers: [driver],
    secretProviders: Effect.sync(secretProviders),
  }).pipe(Layer.provide(NodeServices.layer));

describe("SecretResolver", () => {
  it.effect("reads a reference once and holds it", () => {
    const { driver, reads } = fakeDriver(() => "sk-live");
    return Effect.gen(function* () {
      const resolver = yield* SecretResolver.SecretResolver;
      const token = ref("fake://openai");

      assert.deepStrictEqual(yield* resolver.read([token]), ["sk-live"]);
      assert.deepStrictEqual(yield* resolver.read([token]), ["sk-live"]);
      assert.deepStrictEqual(reads, [{ account: "a", references: ["fake://openai"] }]);
    }).pipe(Effect.provide(resolverLayer(driver)));
  });

  it.effect("holds a failed read until invalidated, then reads again", () => {
    let locked = true;
    const { driver, reads } = fakeDriver(() => (locked ? undefined : "sk-live"));
    return Effect.gen(function* () {
      const resolver = yield* SecretResolver.SecretResolver;
      const token = ref("fake://openai");

      assert.deepStrictEqual(yield* resolver.read([token]), [undefined]);
      locked = false;
      assert.deepStrictEqual(yield* resolver.read([token]), [undefined]);
      assert.strictEqual(reads.length, 1);

      yield* resolver.invalidate([token]);
      assert.deepStrictEqual(yield* resolver.read([token]), ["sk-live"]);
      assert.strictEqual(reads.length, 2);
    }).pipe(Effect.provide(resolverLayer(driver)));
  });

  it.effect("answers a cached reference while another reference waits on its provider", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const unlock = yield* Deferred.make<void>();
      const { driver } = fakeDriver(
        () => "sk-live",
        (references) =>
          references.includes("fake://slow")
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(unlock)))
            : Effect.void,
      );
      yield* Effect.gen(function* () {
        const resolver = yield* SecretResolver.SecretResolver;
        yield* resolver.read([ref("fake://cached")]);
        const slow = yield* Effect.forkChild(resolver.read([ref("fake://slow")]));
        yield* Deferred.await(started);

        assert.deepStrictEqual(yield* resolver.read([ref("fake://cached")]), ["sk-live"]);
        yield* Deferred.succeed(unlock, undefined);
        assert.deepStrictEqual(yield* Fiber.join(slow), ["sk-live"]);
      }).pipe(Effect.provide(resolverLayer(driver)));
    }),
  );

  it.effect("invalidates every reference when none are named", () => {
    const { driver, reads } = fakeDriver(() => "sk-live");
    return Effect.gen(function* () {
      const resolver = yield* SecretResolver.SecretResolver;
      const token = ref("fake://openai");

      yield* resolver.read([token]);
      yield* resolver.invalidate();
      yield* resolver.read([token]);
      assert.strictEqual(reads.length, 2);
    }).pipe(Effect.provide(resolverLayer(driver)));
  });

  it.effect("reads each distinct reference of a provider in one call, in input order", () => {
    const { driver, reads } = fakeDriver((_, reference) => reference.toUpperCase());
    return Effect.gen(function* () {
      const resolver = yield* SecretResolver.SecretResolver;

      const values = yield* resolver.read([ref("fake://a"), ref("fake://b"), ref("fake://a")]);

      assert.deepStrictEqual(values, ["FAKE://A", "FAKE://B", "FAKE://A"]);
      assert.deepStrictEqual(reads, [{ account: "a", references: ["fake://a", "fake://b"] }]);
    }).pipe(Effect.provide(resolverLayer(driver)));
  });

  it.effect("reads each provider separately", () => {
    const { driver, reads } = fakeDriver((account, reference) => `${account}:${reference}`);
    return Effect.gen(function* () {
      const resolver = yield* SecretResolver.SecretResolver;

      const values = yield* resolver.read([ref("fake://a"), ref("fake://a", work)]);

      assert.deepStrictEqual(values, ["a:fake://a", "b:fake://a"]);
      assert.strictEqual(reads.length, 2);
    }).pipe(
      Effect.provide(resolverLayer(driver, () => ({ [personal]: fake("a"), [work]: fake("b") }))),
    );
  });

  it.effect("reads again when the provider's config changes", () => {
    let account = "a";
    const { driver, reads } = fakeDriver((account, reference) => `${account}:${reference}`);
    return Effect.gen(function* () {
      const resolver = yield* SecretResolver.SecretResolver;
      const token = ref("fake://openai");

      assert.deepStrictEqual(yield* resolver.read([token]), ["a:fake://openai"]);
      account = "b";
      assert.deepStrictEqual(yield* resolver.read([token]), ["b:fake://openai"]);
      assert.deepStrictEqual(
        reads.map((read) => read.account),
        ["a", "b"],
      );
    }).pipe(Effect.provide(resolverLayer(driver, () => ({ [personal]: fake(account) }))));
  });

  it.effect("does not call a driver for what it cannot read, and reads it later", () => {
    const { driver, reads } = fakeDriver(() => "sk-live");
    const providers: ServerSettings["secretProviders"] = {
      [personal]: fake("a"),
      [SecretProviderId.make("vault")]: {
        kind: SecretProviderKind.make("openbao"),
        label: "Vault",
      },
      [SecretProviderId.make("broken")]: { kind: FAKE_KIND, label: "Broken", config: {} },
    };
    return Effect.gen(function* () {
      const resolver = yield* SecretResolver.SecretResolver;

      const values = yield* resolver.read([
        ref("fake://openai", SecretProviderId.make("missing")),
        ref("fake://openai", SecretProviderId.make("vault")),
        ref("fake://openai", SecretProviderId.make("broken")),
        ref("openai"),
      ]);

      assert.deepStrictEqual(values, [undefined, undefined, undefined, undefined]);
      assert.strictEqual(reads.length, 0);
    }).pipe(Effect.provide(resolverLayer(driver, () => providers)));
  });
});
