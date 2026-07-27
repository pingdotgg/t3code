import { InstanceId } from "@/InstanceId.ts";
import { createPhysicalName } from "@/PhysicalName.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

type StackShape = Omit<StackSpec, "output">;

const stack: StackShape = {
  name: "my-stack",
  stage: "dev",
  resources: {},
  bindings: {},
  actions: {},
};

const provide = <A, E>(
  effect: Effect.Effect<A, E, Stack | Stage | InstanceId>,
  instanceId = "0123456789abcdef0123456789abcdef",
) =>
  effect.pipe(
    Effect.provideService(Stack, stack),
    Effect.provideService(Stage, stack.stage),
    Effect.provideService(InstanceId, instanceId),
  );

describe("createPhysicalName", () => {
  it.effect("keeps short names untruncated", () =>
    provide(
      Effect.gen(function* () {
        const name = yield* createPhysicalName({ id: "api", maxLength: 64 });
        expect(name.length).toBeLessThanOrEqual(64);
        expect(name.startsWith("my-stack-api-dev-")).toBe(true);
      }),
    ),
  );

  it.effect("is deterministic for the same inputs", () =>
    provide(
      Effect.gen(function* () {
        const longId = "a".repeat(80);
        const first = yield* createPhysicalName({ id: longId, maxLength: 64 });
        const second = yield* createPhysicalName({ id: longId, maxLength: 64 });
        expect(first).toBe(second);
        expect(first.length).toBe(64);
      }),
    ),
  );

  it.effect(
    "preserves suffix uniqueness when a long id truncates away the suffix (task-role vs execution-role)",
    () =>
      provide(
        Effect.gen(function* () {
          // Pathological logical id: long enough that `${stack}-${id}-…` alone
          // exceeds IAM's 64-char role-name limit, so the distinguishing
          // `-task-role` / `-execution-role` tail falls entirely inside the
          // truncated region. Both names share the same InstanceId (same
          // resource), which is exactly the collision scenario.
          const longId = "my-very-long-container-platform-service-logical-id";
          const taskRole = yield* createPhysicalName({
            id: `${longId}-task-role`,
            maxLength: 64,
          });
          const executionRole = yield* createPhysicalName({
            id: `${longId}-execution-role`,
            maxLength: 64,
          });
          expect(taskRole.length).toBe(64);
          expect(executionRole.length).toBe(64);
          expect(taskRole).not.toBe(executionRole);
        }),
      ),
  );

  it.effect(
    "distinguishes every colliding suffix pair used by role helpers",
    () =>
      provide(
        Effect.gen(function* () {
          const longId = "z".repeat(100);
          const suffixes = [
            "task-role",
            "execution-role",
            "job-role",
            "instance-role",
            "access-role",
          ];
          const names = yield* Effect.forEach(suffixes, (suffix) =>
            createPhysicalName({ id: `${longId}-${suffix}`, maxLength: 64 }),
          );
          expect(new Set(names).size).toBe(suffixes.length);
          for (const name of names) {
            expect(name.length).toBe(64);
          }
        }),
      ),
  );

  it.effect("different instance ids still produce different names", () =>
    Effect.gen(function* () {
      const longId = "b".repeat(80);
      const first = yield* provide(
        createPhysicalName({ id: longId, maxLength: 64 }),
        "0123456789abcdef0123456789abcdef",
      );
      const second = yield* provide(
        createPhysicalName({ id: longId, maxLength: 64 }),
        "fedcba9876543210fedcba9876543210",
      );
      expect(first).not.toBe(second);
    }),
  );

  it.effect(
    "keeps the full hash under tight limits (DAX-style maxLength 20)",
    () =>
      provide(
        Effect.gen(function* () {
          // maxLength 20 with the default 16-char instance suffix leaves no
          // room for prefix + hash + suffix; the hash must survive in full
          // (the suffix shrinks) or same-resource names collide again.
          const longId = "c".repeat(60);
          const names = yield* Effect.forEach(["alpha", "beta"], (suffix) =>
            createPhysicalName({
              id: `${longId}-${suffix}`,
              maxLength: 20,
              lowercase: true,
            }),
          );
          expect(names[0]!.length).toBe(20);
          expect(names[1]!.length).toBe(20);
          expect(names[0]).not.toBe(names[1]);
        }),
      ),
  );

  it.effect(
    "keeps uniqueness with a shortened suffixLength (Canary-style 21/8)",
    () =>
      provide(
        Effect.gen(function* () {
          const longId = "d".repeat(60);
          const names = yield* Effect.forEach(["alpha", "beta"], (suffix) =>
            createPhysicalName({
              id: `${longId}-${suffix}`,
              maxLength: 21,
              suffixLength: 8,
              lowercase: true,
            }),
          );
          expect(names[0]!.length).toBe(21);
          expect(names[0]).not.toBe(names[1]);
        }),
      ),
  );

  it.effect("lowercase truncated names stay DNS-safe", () =>
    provide(
      Effect.gen(function* () {
        const name = yield* createPhysicalName({
          id: `MyMixedCase_${"x".repeat(80)}`,
          maxLength: 63,
          lowercase: true,
        });
        expect(name.length).toBe(63);
        expect(name).toMatch(/^[a-z0-9-]+$/);
      }),
    ),
  );
});
