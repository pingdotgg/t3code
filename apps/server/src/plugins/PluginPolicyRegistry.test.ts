import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import type { PluginPolicyRequest } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { make } from "./PluginPolicyRegistry.ts";

const request: PluginPolicyRequest = {
  threadId: ThreadId.make("thread-policy"),
  kind: "command",
  detail: "rm -rf /",
  cwd: "/work",
};

class HookExploded extends Error {
  readonly _tag = "HookExploded";
}

describe("PluginPolicyRegistry", () => {
  it.effect("defers when no plugin has an opinion", () =>
    Effect.gen(function* () {
      const registry = yield* make();
      const outcome = yield* registry.evaluate(request);
      // "defer" is the host's own behaviour — ask the user. A registry with no hooks
      // must be indistinguishable from no plugins installed.
      assert.deepStrictEqual(outcome, { decision: "defer", deniedBy: null, reason: null });
    }),
  );

  it.effect("denies, naming the plugin and its own reason", () =>
    Effect.gen(function* () {
      const registry = yield* make();
      yield* registry.put("plugin-a", [
        {
          name: "no-rm",
          onApprovalRequest: () =>
            Effect.succeed({ decision: "deny" as const, reason: "rm -rf is never allowed here" }),
        },
      ]);

      const outcome = yield* registry.evaluate(request);
      assert.strictEqual(outcome.decision, "deny");
      assert.strictEqual(outcome.deniedBy, "plugin-a");
      // The plugin's own words: a host-invented reason would be a guess at why
      // someone else's rule fired.
      assert.strictEqual(outcome.reason, "rm -rf is never allowed here");
    }),
  );

  it.effect("stops at the first deny", () =>
    Effect.gen(function* () {
      const registry = yield* make();
      const secondRan = yield* Ref.make(false);
      yield* registry.put("plugin-a", [
        {
          name: "denies",
          onApprovalRequest: () => Effect.succeed({ decision: "deny" as const }),
        },
      ]);
      yield* registry.put("plugin-b", [
        {
          name: "never-reached",
          onApprovalRequest: () =>
            Ref.set(secondRan, true).pipe(Effect.as({ decision: "defer" as const })),
        },
      ]);

      yield* registry.evaluate(request);
      // Nothing can undo a deny — there is no "allow" — so running later hooks would
      // only add latency to a decision already made.
      assert.isFalse(yield* Ref.get(secondRan));
    }),
  );

  it.effect("defers when a hook fails", () =>
    Effect.gen(function* () {
      const registry = yield* make();
      yield* registry.put("plugin-a", [
        { name: "broken", onApprovalRequest: () => Effect.fail(new HookExploded()) },
      ]);

      const outcome = yield* registry.evaluate(request);
      // Deferring on failure sounds less "safe" than denying, but denying would mean a
      // crashed plugin silently blocks all work with no way to see why. Deferring is
      // what the host did before the plugin existed, so it cannot escalate anything.
      assert.strictEqual(outcome.decision, "defer");
    }),
  );

  it.effect("defers when a hook hangs, rather than making the user wait", () =>
    Effect.gen(function* () {
      const registry = yield* make();
      yield* registry.put("plugin-a", [{ name: "hung", onApprovalRequest: () => Effect.never }]);

      const fiber = yield* Effect.forkChild(registry.evaluate(request));
      yield* TestClock.adjust("4 seconds");
      const outcome = yield* Fiber.join(fiber);

      // The user is sitting in front of a prompt that has not appeared yet.
      assert.strictEqual(outcome.decision, "defer");
    }),
  );

  it.effect("bounds the whole evaluation, not just each hook", () =>
    Effect.gen(function* () {
      const registry = yield* make();
      for (let index = 0; index < 10; index += 1) {
        yield* registry.put(`plugin-${index}`, [
          { name: `hung-${index}`, onApprovalRequest: () => Effect.never },
        ]);
      }

      const fiber = yield* Effect.forkChild(registry.evaluate(request));
      // Per-hook timeouts stack: 10 x 3s would be 30s in front of every prompt.
      yield* TestClock.adjust("6 seconds");
      const outcome = yield* Fiber.join(fiber);

      assert.strictEqual(outcome.decision, "defer");
    }),
  );

  it.effect("sees the request it is being asked about", () =>
    Effect.gen(function* () {
      const registry = yield* make();
      const seen = yield* Ref.make<PluginPolicyRequest | null>(null);
      yield* registry.put("plugin-a", [
        {
          name: "inspects",
          onApprovalRequest: (received) =>
            Ref.set(seen, received).pipe(Effect.as({ decision: "defer" as const })),
        },
      ]);

      yield* registry.evaluate(request);
      assert.deepStrictEqual(yield* Ref.get(seen), request);
    }),
  );

  it.effect("stops consulting a removed plugin", () =>
    Effect.gen(function* () {
      const registry = yield* make();
      yield* registry.put("plugin-a", [
        { name: "denies", onApprovalRequest: () => Effect.succeed({ decision: "deny" as const }) },
      ]);
      yield* registry.remove("plugin-a");

      // A disabled plugin that kept blocking the agent would be a disabled plugin that
      // is still running — and the user would have no way to tell what stopped them.
      const outcome = yield* registry.evaluate(request);
      assert.strictEqual(outcome.decision, "defer");
    }),
  );
});
