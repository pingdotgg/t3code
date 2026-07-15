import { assert, describe, it } from "@effect/vitest";
import type { PluginProviderDescriptor } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { findProviderDescriptorViolation, make } from "./PluginProviderRegistry.ts";

const BUILT_IN = new Set(["codex", "claude", "cursor", "grok", "opencode"]);

const noopDriver = {
  startSession: () => Effect.void,
  sendTurn: () => Effect.void,
  stopSession: () => Effect.void,
};

const provider = (overrides: Partial<PluginProviderDescriptor> = {}): PluginProviderDescriptor => ({
  driverKind: "acme",
  displayName: "Acme AI",
  configSchema: Schema.Struct({ apiBase: Schema.String }) as never,
  driver: noopDriver,
  ...overrides,
});

describe("findProviderDescriptorViolation", () => {
  it("accepts a driver whose kind is free", () => {
    assert.isNull(
      findProviderDescriptorViolation({ descriptor: provider(), takenKinds: BUILT_IN }),
    );
  });

  it("refuses a kind already taken", () => {
    // A driver kind is the ROUTING key. Two drivers claiming one means every instance
    // resolves to whichever registered last.
    const violation = findProviderDescriptorViolation({
      descriptor: provider({ driverKind: "codex" }),
      takenKinds: BUILT_IN,
    });
    assert.isNotNull(violation);
    assert.match(violation ?? "", /routing key/);
  });

  it("refuses an empty kind", () => {
    assert.isNotNull(
      findProviderDescriptorViolation({
        descriptor: provider({ driverKind: "  " }),
        takenKinds: BUILT_IN,
      }),
    );
  });

  it("refuses a driver with no displayName", () => {
    // It is what the user picks in settings; an unnamed provider is unpickable.
    assert.isNotNull(
      findProviderDescriptorViolation({
        descriptor: provider({ displayName: "" }),
        takenKinds: BUILT_IN,
      }),
    );
  });
});

describe("PluginProviderRegistry", () => {
  it.effect("registers and lists a plugin's driver", () =>
    Effect.gen(function* () {
      const registry = yield* make(BUILT_IN);
      yield* registry.put("plugin-a", [provider()]);

      const listed = yield* registry.list;
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.pluginId, "plugin-a");
      assert.strictEqual(listed[0]?.descriptor.driverKind, "acme");
    }),
  );

  it.effect("refuses a plugin trying to shadow a BUILT-IN provider", () =>
    Effect.gen(function* () {
      const registry = yield* make(BUILT_IN);
      // The dangerous case: a plugin quietly claiming "codex" would see every request
      // meant for the real one.
      const result = yield* Effect.result(
        registry.put("plugin-a", [provider({ driverKind: "codex" })]),
      );

      assert.isTrue(Result.isFailure(result));
      assert.strictEqual((yield* registry.list).length, 0, "nothing may be registered on refusal");
    }),
  );

  it.effect("refuses a plugin trying to shadow ANOTHER plugin's driver", () =>
    Effect.gen(function* () {
      const registry = yield* make(BUILT_IN);
      yield* registry.put("plugin-a", [provider({ driverKind: "acme" })]);

      const result = yield* Effect.result(
        registry.put("plugin-b", [provider({ driverKind: "acme" })]),
      );

      assert.isTrue(Result.isFailure(result));
      assert.strictEqual((yield* registry.list).length, 1, "the first registration stands");
    }),
  );

  it.effect("refuses two drivers claiming the same kind in ONE plugin", () =>
    Effect.gen(function* () {
      const registry = yield* make(BUILT_IN);
      const result = yield* Effect.result(
        registry.put("plugin-a", [
          provider({ driverKind: "acme" }),
          provider({ driverKind: "acme" }),
        ]),
      );
      assert.isTrue(Result.isFailure(result));
    }),
  );

  it.effect("lets a plugin re-register its own kinds", () =>
    Effect.gen(function* () {
      const registry = yield* make(BUILT_IN);
      yield* registry.put("plugin-a", [provider({ driverKind: "acme", displayName: "Acme v1" })]);

      // An upgrade re-runs register(). Colliding with ITSELF would make every plugin
      // update fail on its second activation.
      yield* registry.put("plugin-a", [provider({ driverKind: "acme", displayName: "Acme v2" })]);

      const listed = yield* registry.list;
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.descriptor.displayName, "Acme v2");
    }),
  );

  it.effect("frees a kind when the plugin is removed", () =>
    Effect.gen(function* () {
      const registry = yield* make(BUILT_IN);
      yield* registry.put("plugin-a", [provider({ driverKind: "acme" })]);
      yield* registry.remove("plugin-a");

      // Uninstalling a provider plugin must let another claim the slug — otherwise the
      // kind is burned for the process lifetime.
      const result = yield* Effect.result(
        registry.put("plugin-b", [provider({ driverKind: "acme" })]),
      );
      assert.isTrue(Result.isSuccess(result));
    }),
  );

  it.effect("reports built-in kinds as taken", () =>
    Effect.gen(function* () {
      const registry = yield* make(BUILT_IN);
      const taken = yield* registry.takenKinds;
      assert.isTrue(taken.has("codex"));
    }),
  );
});
