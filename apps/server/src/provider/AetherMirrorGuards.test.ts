import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  AETHER_MIRROR_REFUSAL,
  aetherMirrorWriteFileError,
  guardAetherQueuedMutation,
  guardAetherRemoveWorktree,
  guardAetherVcsMutation,
  guardAetherWriteFile,
} from "./AetherMirrorGuards.ts";
import { make } from "./AetherMirrorRegistry.ts";

describe("AetherMirrorGuards", () => {
  it.effect("guardAetherVcsMutation refuses only while a thread owns the cwd", () =>
    Effect.gen(function* () {
      const registry = yield* make;
      yield* registry.register("/repos/mirror", "aether:thread-1");

      const refused = yield* Effect.flip(
        guardAetherVcsMutation(registry, "vcs.pull", "/repos/mirror", Effect.succeed("ran")),
      );
      expect(refused._tag).toBe("GitCommandError");
      expect(refused.detail).toBe(AETHER_MIRROR_REFUSAL);

      expect(
        yield* guardAetherVcsMutation(registry, "vcs.pull", "/repos/other", Effect.succeed("ran")),
      ).toBe("ran");

      yield* registry.deregister("/repos/mirror", "aether:thread-1");
      expect(
        yield* guardAetherVcsMutation(registry, "vcs.pull", "/repos/mirror", Effect.succeed("ran")),
      ).toBe("ran");
    }),
  );

  it.effect(
    "guardAetherRemoveWorktree refuses a parent-repo cwd targeting the mirror (spec note 20)",
    () =>
      Effect.gen(function* () {
        const registry = yield* make;
        yield* registry.register("/repos/parent/.worktrees/aether-mirror", "aether:thread-1");

        // The bypass shape: cwd is the ORDINARY parent repo, the target is
        // the active mirror — by relative path, by absolute path, and by the
        // bare unique basename `git worktree remove` also accepts.
        for (const path of [
          ".worktrees/aether-mirror",
          "/repos/parent/.worktrees/aether-mirror",
          "aether-mirror",
        ]) {
          const refused = yield* Effect.flip(
            guardAetherRemoveWorktree(
              registry,
              { cwd: "/repos/parent", path },
              Effect.succeed("removed"),
            ),
          );
          expect(refused._tag).toBe("GitCommandError");
          expect(refused.detail).toContain("active Aether cloud-session mirror");
        }

        // The mirror's OWN cwd is refused even for an unrelated target.
        const cwdRefused = yield* Effect.flip(
          guardAetherRemoveWorktree(
            registry,
            { cwd: "/repos/parent/.worktrees/aether-mirror", path: ".worktrees/other" },
            Effect.succeed("removed"),
          ),
        );
        expect(cwdRefused.detail).toContain(AETHER_MIRROR_REFUSAL);

        // A sibling worktree from an unowned cwd stays removable.
        expect(
          yield* guardAetherRemoveWorktree(
            registry,
            { cwd: "/repos/parent", path: ".worktrees/other" },
            Effect.succeed("removed"),
          ),
        ).toBe("removed");
      }),
  );

  it.effect("guardAetherWriteFile refuses a write that descends INTO a mirror", () =>
    Effect.gen(function* () {
      const registry = yield* make;
      yield* registry.register("/repos/parent/.worktrees/aether-mirror", "aether:thread-1");

      const refused = yield* Effect.flip(
        guardAetherWriteFile(
          registry,
          { cwd: "/repos/parent", relativePath: ".worktrees/aether-mirror/app.ts" },
          Effect.succeed("written"),
        ),
      );
      expect(refused._tag).toBe("ProjectWriteFileError");
      expect(refused.message).toBe(AETHER_MIRROR_REFUSAL);

      expect(
        yield* guardAetherWriteFile(
          registry,
          { cwd: "/repos/parent", relativePath: "src/app.ts" },
          Effect.succeed("written"),
        ),
      ).toBe("written");
    }),
  );

  it.effect("blocks a registration from landing between the check and the mutation", () =>
    // The race the frozen region exists for: the guard reads "not owned", an
    // Aether session claims the checkout, and THEN the local write lands in
    // what is by now a one-way mirror — silently corrupting the next
    // reset-and-apply.
    Effect.gen(function* () {
      const order: Array<string> = [];
      const registry = yield* make;
      const mutationStarted = yield* Deferred.make<void>();
      const releaseMutation = yield* Deferred.make<void>();

      const guarded = yield* Effect.forkChild(
        guardAetherVcsMutation(
          registry,
          "vcs.pull",
          "/repos/mirror",
          Effect.gen(function* () {
            yield* Deferred.succeed(mutationStarted, undefined);
            yield* Deferred.await(releaseMutation);
            order.push("mutation");
            return "ran";
          }),
        ),
      );
      // The guard has passed its check and is inside the mutation.
      yield* Deferred.await(mutationStarted);

      const registering = yield* Effect.forkChild(
        registry
          .register("/repos/mirror", "aether:thread-1")
          .pipe(Effect.tap(() => Effect.sync(() => order.push("register")))),
      );
      // Real elapsed time, deliberately: the registration's own async work
      // (realpath) must have had every chance to finish, which a virtual clock
      // would not give it.
      // @effect-diagnostics-next-line globalTimers:off
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
      // Still nothing: the claim cannot appear underneath an in-flight mutation.
      expect(order).toEqual([]);

      yield* Deferred.succeed(releaseMutation, undefined);
      expect(yield* Fiber.join(guarded)).toBe("ran");
      yield* Fiber.join(registering);
      expect(order).toEqual(["mutation", "register"]);

      // …and once registered, the next mutation is refused.
      const refused = yield* Effect.flip(
        guardAetherVcsMutation(registry, "vcs.pull", "/repos/mirror", Effect.succeed("ran")),
      );
      expect(refused.detail).toContain(AETHER_MIRROR_REFUSAL);
    }),
  );

  it.effect("guardAetherQueuedMutation refuses through its queue, not its error channel", () =>
    Effect.gen(function* () {
      const registry = yield* make;
      yield* registry.register("/repos/mirror", "aether:thread-1");
      const refusals: Array<string> = [];
      const ran: Array<string> = [];

      yield* guardAetherQueuedMutation(
        registry,
        "/repos/mirror",
        Effect.sync(() => void refusals.push("refused")),
        Effect.sync(() => void ran.push("ran")),
      );
      expect(refusals).toEqual(["refused"]);
      expect(ran).toEqual([]);

      yield* guardAetherQueuedMutation(
        registry,
        "/repos/elsewhere",
        Effect.sync(() => void refusals.push("refused")),
        Effect.sync(() => void ran.push("ran")),
      );
      expect(ran).toEqual(["ran"]);
    }),
  );

  it.effect("a registration cannot land between a QUEUED mutation's check and its run", () =>
    // The gap the round-5 lock left open: `git.runStackedAction` checked
    // ownership outside any frozen region, so it held no reader permit and the
    // exclusive registration never waited — its commit/branch/push could land
    // in a checkout that had just become a one-way mirror.
    Effect.gen(function* () {
      const order: Array<string> = [];
      const registry = yield* make;
      const runStarted = yield* Deferred.make<void>();
      const releaseRun = yield* Deferred.make<void>();

      const guarded = yield* Effect.forkChild(
        guardAetherQueuedMutation(
          registry,
          "/repos/mirror",
          Effect.sync(() => void order.push("refused")),
          Effect.gen(function* () {
            yield* Deferred.succeed(runStarted, undefined);
            yield* Deferred.await(releaseRun);
            order.push("stacked-action");
          }),
        ),
      );
      yield* Deferred.await(runStarted);

      const registering = yield* Effect.forkChild(
        registry
          .register("/repos/mirror", "aether:thread-1")
          .pipe(Effect.tap(() => Effect.sync(() => order.push("register")))),
      );
      // Real elapsed time so the registration's own realpath can resolve.
      // @effect-diagnostics-next-line globalTimers:off
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(order).toEqual([]);

      yield* Deferred.succeed(releaseRun, undefined);
      yield* Fiber.join(guarded);
      yield* Fiber.join(registering);
      expect(order).toEqual(["stacked-action", "register"]);
    }),
  );

  it.effect("a register on an UNRELATED checkout does not wait for an in-flight mutation", () =>
    // The freeze is scoped to what a mutation writes, not process-global. A
    // stacked action holds it across its network push, so a global freeze
    // would let one slow (or hung) push on project A stall every Aether
    // session start — including project B, which it can never touch.
    Effect.gen(function* () {
      const order: Array<string> = [];
      const registry = yield* make;
      const pushStarted = yield* Deferred.make<void>();
      const releasePush = yield* Deferred.make<void>();

      const guarded = yield* Effect.forkChild(
        guardAetherQueuedMutation(
          registry,
          "/repos/projectA",
          Effect.sync(() => void order.push("refused")),
          Effect.gen(function* () {
            yield* Deferred.succeed(pushStarted, undefined);
            yield* Deferred.await(releasePush);
            order.push("projectA-push");
          }),
        ),
      );
      yield* Deferred.await(pushStarted);

      // Project B's session starts WHILE project A's push is still running.
      yield* registry.register("/repos/projectB", "aether:thread-b");
      order.push("projectB-register");
      expect(order).toEqual(["projectB-register"]);
      // …and it really did claim B.
      expect(yield* registry.ownsCwd("/repos/projectB")).toBe(true);

      yield* Deferred.succeed(releasePush, undefined);
      yield* Fiber.join(guarded);
      expect(order).toEqual(["projectB-register", "projectA-push"]);
    }),
  );

  it.effect("a register on a checkout the mutation writes INTO still waits", () =>
    // The other half: scoping must not lose same-checkout serialization, nor
    // the descend-into-a-mirror case a file write can reach.
    Effect.gen(function* () {
      const order: Array<string> = [];
      const registry = yield* make;
      const writeStarted = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();

      const guarded = yield* Effect.forkChild(
        guardAetherWriteFile(
          registry,
          { cwd: "/repos/parent", relativePath: ".worktrees/mirror/app.ts" },
          Effect.gen(function* () {
            yield* Deferred.succeed(writeStarted, undefined);
            yield* Deferred.await(releaseWrite);
            order.push("write");
          }),
        ),
      );
      yield* Deferred.await(writeStarted);

      const registering = yield* Effect.forkChild(
        registry
          .register("/repos/parent/.worktrees/mirror", "aether:thread-1")
          .pipe(Effect.tap(() => Effect.sync(() => order.push("register")))),
      );
      // @effect-diagnostics-next-line globalTimers:off
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(order).toEqual([]);

      yield* Deferred.succeed(releaseWrite, undefined);
      yield* Fiber.join(guarded);
      yield* Fiber.join(registering);
      expect(order).toEqual(["write", "register"]);
    }),
  );

  it.effect("a removeWorktree blocks a same-basename registration ANYWHERE on disk", () =>
    // `ownsTargetPath` also refuses on a bare basename match, because
    // `git worktree remove <name>` resolves a bare component to a worktree the
    // request never spells out. Freezing only the paths the request names
    // would leave that worktree registerable elsewhere between the check and
    // the delete — and git would then remove the mirror it had just claimed.
    Effect.gen(function* () {
      const order: Array<string> = [];
      const registry = yield* make;
      const removalStarted = yield* Deferred.make<void>();
      const releaseRemoval = yield* Deferred.make<void>();

      const guarded = yield* Effect.forkChild(
        guardAetherRemoveWorktree(
          registry,
          { cwd: "/repos/projA", path: "feature-x" },
          Effect.gen(function* () {
            yield* Deferred.succeed(removalStarted, undefined);
            yield* Deferred.await(releaseRemoval);
            order.push("removed");
            return "removed";
          }),
        ),
      );
      yield* Deferred.await(removalStarted);

      // The worktree git would actually delete lives nowhere near the request:
      // only the BASENAME ties them together.
      const registering = yield* Effect.forkChild(
        registry
          .register("/var/worktrees/projA/feature-x", "aether:thread-1")
          .pipe(Effect.tap(() => Effect.sync(() => order.push("register")))),
      );
      // @effect-diagnostics-next-line globalTimers:off
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(order).toEqual([]);

      yield* Deferred.succeed(releaseRemoval, undefined);
      yield* Fiber.join(guarded);
      yield* Fiber.join(registering);
      expect(order).toEqual(["removed", "register"]);
    }),
  );

  it("aetherMirrorWriteFileError carries the refusal as its message", () => {
    const error = aetherMirrorWriteFileError({ cwd: "/repos/mirror", relativePath: "src/a.ts" });
    expect(error._tag).toBe("ProjectWriteFileError");
    expect(error.failure).toBe("aether_mirror_read_only");
    // The message is derived from the aether_mirror_read_only failure literal —
    // the web UI renders exactly this text.
    expect(error.message).toBe(AETHER_MIRROR_REFUSAL);
  });
});
