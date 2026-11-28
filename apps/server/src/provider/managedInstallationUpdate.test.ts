import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { makeManagedInstallationMaintenance } from "./managedInstallationUpdate.ts";

const provider = ProviderDriverKind.make("antigravity");
const idle: ProviderInstallState = {
  driver: provider,
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: "1.5.15",
  installedVersion: "1.5.14",
  canRemove: true,
  message: null,
};

const makeInstallation = Effect.fn(function* () {
  const state = yield* SubscriptionRef.make(idle);
  return {
    state,
    installation: {
      start: SubscriptionRef.updateAndGet(state, (current) => ({
        ...current,
        operationId: "op-1",
        phase: "downloading" as const,
        message: "Downloading the runtime.",
      })),
      changes: SubscriptionRef.changes(state),
      state: SubscriptionRef.get(state),
      checkForUpdate: Effect.void,
    },
  };
});

const managedExecutable = Option.some({ source: "managed", executablePath: "/managed/agy" });

describe("makeManagedInstallationMaintenance", () => {
  it.effect("keeps instances outside the managed runtime manual-only", () =>
    Effect.gen(function* () {
      const { installation } = yield* makeInstallation();
      const external = makeManagedInstallationMaintenance({
        provider,
        installation,
        executable: Option.some({ source: "path", executablePath: "/usr/bin/agy" }),
      });
      assert.isUndefined(external.managedUpdate);
      assert.strictEqual(external.installPath, "/usr/bin/agy");

      const managed = makeManagedInstallationMaintenance({
        provider,
        installation,
        executable: managedExecutable,
      });
      assert.strictEqual(managed.managedUpdate?.lockKey, "antigravity-managed");
      assert.strictEqual(yield* managed.lookupLatestVersion!, "1.5.15");
    }),
  );

  it.effect("reports install messages once each and the operation's outcome", () =>
    Effect.gen(function* () {
      const { state, installation } = yield* makeInstallation();
      const managed = makeManagedInstallationMaintenance({
        provider,
        installation,
        executable: managedExecutable,
      });
      const progress = yield* Queue.unbounded<string>();
      const running = yield* Effect.forkChild(
        managed.managedUpdate!.run((line) => Queue.offer(progress, line).pipe(Effect.asVoid)),
      );
      assert.strictEqual(yield* Queue.take(progress), "Downloading the runtime.");
      yield* SubscriptionRef.update(state, (current) => ({ ...current, downloadedBytes: 1_000 }));
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        phase: "failed" as const,
        message: "Checksum mismatch.",
      }));
      assert.deepStrictEqual(yield* Fiber.join(running), {
        status: "failed",
        message: "Checksum mismatch.",
      });
      assert.strictEqual(yield* Queue.size(progress), 0);
    }),
  );
});
