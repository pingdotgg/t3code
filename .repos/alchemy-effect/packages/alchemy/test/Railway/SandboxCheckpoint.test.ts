import * as railway from "@distilled.cloud/railway";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { State, type UpdatingReourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { suitePartition } from "./suiteProject.ts";

const { test } = Test.make({ providers: Railway.providers() });

const Base = Effect.gen(function* () {
  const { environment } = yield* suitePartition;
  const box = yield* Railway.Sandbox("Source", {
    environment,
    idleTimeoutMinutes: 5,
  });
  return { environment, box };
});

const listLive = (environmentId: string) =>
  railway.sandboxCheckpoints(
    { environmentId },
    { id: true, key: true, createdAt: true, environmentId: true },
  );

const Snapshot = (name?: string, restore = false) =>
  Effect.gen(function* () {
    const { environment, box } = yield* Base;
    const checkpoint = yield* Railway.SandboxCheckpoint("Snapshot", {
      sandbox: box,
      name,
    });
    const restored = restore
      ? yield* Railway.Sandbox("Restored", {
          environment,
          idleTimeoutMinutes: 5,
          template: { name: checkpoint.key },
        })
      : undefined;
    return { environment, box, checkpoint, restored };
  });

test.provider(
  "capture, list, rename, restore, and delete a sandbox checkpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const base = yield* stack.deploy(Base);
      const written = yield* Railway.execSandbox({
        sandboxId: base.box.sandboxId,
        environmentId: base.box.environmentId,
        command: "echo checkpoint-content > /tmp/alchemy-checkpoint.txt",
        timeoutSec: 10,
      });
      expect(written.exitCode).toBe(0);

      const created = yield* stack.deploy(Snapshot());
      const original = created.checkpoint;
      expect(original.sandboxId).toBe(base.box.sandboxId);
      expect(original.key).toBe(original.name);
      expect(original.name.length).toBeGreaterThan(0);
      const live = yield* listLive(base.box.environmentId);
      expect(
        live.find((item) => item.id === original.sandboxCheckpointId),
      ).toEqual({
        id: original.sandboxCheckpointId,
        key: original.key,
        createdAt: original.createdAt,
        environmentId: original.environmentId,
      });
      const provider = yield* Provider.findProvider(Railway.SandboxCheckpoint);
      expect(
        (yield* provider.list()).some(
          (item) =>
            item.sandboxCheckpointId === original.sandboxCheckpointId &&
            item.environmentId === original.environmentId,
        ),
      ).toBe(true);

      const unchanged = yield* stack.deploy(Snapshot());
      expect(unchanged.checkpoint).toEqual(original);
      const renamed = yield* stack.deploy(
        Snapshot("restorable-checkpoint", true),
      );
      expect(renamed.checkpoint.name).toBe("restorable-checkpoint");
      expect(renamed.checkpoint.createdAt).toBe(original.createdAt);
      const renamedLive = yield* listLive(base.box.environmentId);
      expect(renamedLive.some((item) => item.key === original.key)).toBe(false);
      expect(
        renamedLive.find((item) => item.key === renamed.checkpoint.key)?.id,
      ).toBe(renamed.checkpoint.sandboxCheckpointId);
      expect(renamed.restored).toBeDefined();
      const restored = yield* Railway.execSandbox({
        sandboxId: renamed.restored!.sandboxId,
        environmentId: base.box.environmentId,
        command: "cat /tmp/alchemy-checkpoint.txt",
        timeoutSec: 10,
      });
      expect(restored.exitCode).toBe(0);
      expect(restored.stdout.trim()).toBe("checkpoint-content");

      const resetName = yield* stack.deploy(Snapshot());
      expect(resetName.checkpoint.key).toBe(original.key);
      expect(resetName.checkpoint.createdAt).toBe(original.createdAt);

      yield* stack.deploy(Base);
      expect(yield* listLive(base.box.environmentId)).toEqual([]);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "replace a checkpoint when its source changes without removing either source",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (second: boolean) =>
        Effect.gen(function* () {
          const { environment, box } = yield* Base;
          const other = yield* Railway.Sandbox("Other", {
            environment,
            idleTimeoutMinutes: 5,
          });
          const checkpoint = yield* Railway.SandboxCheckpoint("Snapshot", {
            sandbox: second ? other : box,
            name: "replace-source-checkpoint",
          });
          return { box, other, checkpoint };
        });
      const before = yield* stack.deploy(program(false));
      const after = yield* stack.deploy(program(true));
      expect(after.box.sandboxId).toBe(before.box.sandboxId);
      expect(after.other.sandboxId).toBe(before.other.sandboxId);
      expect(after.checkpoint.sandboxId).toBe(after.other.sandboxId);
      expect(after.checkpoint.createdAt).not.toBe(before.checkpoint.createdAt);
      const live = yield* listLive(after.box.environmentId);
      expect(live).toHaveLength(1);
      expect(live[0]?.createdAt).toBe(after.checkpoint.createdAt);
      yield* stack.deploy(Base);
      expect(yield* listLive(after.box.environmentId)).toEqual([]);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "recover interrupted renames without adopting or deleting a foreign capture",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const state = yield* yield* State;
      const provider = yield* Provider.findProvider(Railway.SandboxCheckpoint);
      const key = { stack: stack.name, stage: stack.stage, fqn: "Snapshot" };
      for (const recapture of [false, true]) {
        const created = yield* stack.deploy(Snapshot("before-rename"));
        const persisted = yield* state.get(key);
        if (
          persisted?.status !== "created" &&
          persisted?.status !== "updated"
        ) {
          return yield* Effect.fail(
            new Error("Expected a stable checkpoint row"),
          );
        }
        const attempted: Railway.SandboxCheckpointProps = {
          sandbox: {
            sandboxId: created.box.sandboxId,
            environmentId: created.box.environmentId,
          },
          name: "attempted-rename",
        };
        // Apply commits attempted props before invoking the rename mutation.
        yield* state.set({
          ...key,
          value: {
            ...persisted,
            status: "updating",
            props: attempted,
            old: persisted,
          } satisfies UpdatingReourceState,
        });
        const renamed = yield* railway.renameSandboxCheckpoint(
          {
            environmentId: created.box.environmentId,
            id: created.checkpoint.sandboxCheckpointId,
            name: attempted.name!,
          },
          { id: true, key: true, createdAt: true },
        );
        expect(renamed.createdAt).toBe(created.checkpoint.createdAt);
        let live = renamed;
        if (recapture) {
          yield* railway.deleteSandboxCheckpoint({
            environmentId: created.box.environmentId,
            id: renamed.id,
          });
          live = yield* railway.createSandboxCheckpoint(
            {
              environmentId: created.box.environmentId,
              sandboxId: created.box.sandboxId,
              name: attempted.name!,
            },
            { id: true, key: true, createdAt: true },
          );
          expect(live.createdAt).not.toBe(created.checkpoint.createdAt);
        }
        // The successful rename's returned attributes were never persisted.
        const read = yield* Effect.result(
          provider.read!({
            id: "Snapshot",
            fqn: "Snapshot",
            instanceId: persisted.instanceId,
            olds: attempted,
            output: created.checkpoint,
          }),
        );
        if (recapture) {
          expect(Result.isFailure(read)).toBe(true);
          if (Result.isFailure(read)) {
            expect(read.failure).toBeInstanceOf(OwnedBySomeoneElse);
          }
        } else {
          expect(Result.isSuccess(read)).toBe(true);
          if (Result.isSuccess(read)) {
            expect(read.success).toMatchObject({
              sandboxCheckpointId: renamed.id,
              key: renamed.key,
              createdAt: created.checkpoint.createdAt,
            });
          }
        }
        // Deletion must recover directly from attempted props and stale attrs.
        yield* stack.deploy(Base);
        const remaining = yield* listLive(created.box.environmentId);
        if (recapture) {
          expect(remaining).toHaveLength(1);
          expect(remaining[0]?.id).toBe(live.id);
          expect(remaining[0]?.createdAt).toBe(live.createdAt);
          yield* railway.deleteSandboxCheckpoint({
            environmentId: created.box.environmentId,
            id: live.id,
          });
        } else {
          expect(remaining).toEqual([]);
        }
        expect(yield* listLive(created.box.environmentId)).toEqual([]);
      }
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "require adoption and preserve a foreign recapture with the same checkpoint name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const base = yield* stack.deploy(Base);
      const foreign = yield* railway.createSandboxCheckpoint(
        {
          environmentId: base.box.environmentId,
          sandboxId: base.box.sandboxId,
          name: "foreign-checkpoint",
        },
        { id: true, createdAt: true },
      );
      const program = (allowAdoption: boolean, name = "foreign-checkpoint") =>
        Effect.gen(function* () {
          const { box } = yield* Base;
          return yield* Railway.SandboxCheckpoint("Snapshot", {
            sandbox: box,
            name,
          }).pipe(adopt(allowAdoption));
        });
      const denied = yield* Effect.result(stack.deploy(program(false)));
      expect(Result.isFailure(denied)).toBe(true);
      if (Result.isFailure(denied)) {
        expect(denied.failure).toBeInstanceOf(OwnedBySomeoneElse);
      }
      expect((yield* listLive(base.box.environmentId))[0]?.createdAt).toBe(
        foreign.createdAt,
      );

      const adopted = yield* stack.deploy(program(true));
      expect(adopted.sandboxCheckpointId).toBe(foreign.id);
      expect(adopted.createdAt).toBe(foreign.createdAt);
      const occupied = yield* railway.createSandboxCheckpoint(
        {
          environmentId: base.box.environmentId,
          sandboxId: base.box.sandboxId,
          name: "occupied-checkpoint",
        },
        { id: true, createdAt: true },
      );
      const collision = yield* Effect.result(
        stack.deploy(program(false, "occupied-checkpoint")),
      );
      expect(Result.isFailure(collision)).toBe(true);
      const afterCollision = yield* listLive(base.box.environmentId);
      expect(afterCollision).toHaveLength(2);
      expect(
        afterCollision.find((item) => item.id === occupied.id)?.createdAt,
      ).toBe(occupied.createdAt);
      expect(
        afterCollision.find((item) => item.id === foreign.id)?.createdAt,
      ).toBe(foreign.createdAt);
      yield* railway.deleteSandboxCheckpoint({
        environmentId: base.box.environmentId,
        id: occupied.id,
      });
      yield* stack.deploy(program(false));
      yield* railway.deleteSandboxCheckpoint({
        environmentId: base.box.environmentId,
        id: foreign.id,
      });
      const replacement = yield* railway.createSandboxCheckpoint(
        {
          environmentId: base.box.environmentId,
          sandboxId: base.box.sandboxId,
          name: "foreign-checkpoint",
        },
        { id: true, createdAt: true },
      );
      expect(replacement.createdAt).not.toBe(adopted.createdAt);
      const provider = yield* Provider.findProvider(Railway.SandboxCheckpoint);
      const read = yield* Effect.result(
        provider.read!({
          id: "Snapshot",
          fqn: "Snapshot",
          instanceId: "unused",
          olds: {
            sandbox: {
              sandboxId: base.box.sandboxId,
              environmentId: base.box.environmentId,
            },
            name: "foreign-checkpoint",
          },
          output: adopted,
        }),
      );
      expect(Result.isFailure(read)).toBe(true);
      if (Result.isFailure(read)) {
        expect(read.failure).toBeInstanceOf(OwnedBySomeoneElse);
      }

      yield* stack.deploy(Base);
      const preserved = yield* listLive(base.box.environmentId);
      expect(preserved).toHaveLength(1);
      expect(preserved[0]?.id).toBe(replacement.id);
      expect(preserved[0]?.createdAt).toBe(replacement.createdAt);
      yield* railway.deleteSandboxCheckpoint({
        environmentId: base.box.environmentId,
        id: replacement.id,
      });
      expect(yield* listLive(base.box.environmentId)).toEqual([]);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
