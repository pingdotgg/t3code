import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  AETHER_MIRROR_REFUSAL,
  aetherMirrorWriteFileError,
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

  it("aetherMirrorWriteFileError carries the refusal as its message", () => {
    const error = aetherMirrorWriteFileError({ cwd: "/repos/mirror", relativePath: "src/a.ts" });
    expect(error._tag).toBe("ProjectWriteFileError");
    expect(error.failure).toBe("aether_mirror_read_only");
    // The message is derived from the aether_mirror_read_only failure literal —
    // the web UI renders exactly this text.
    expect(error.message).toBe(AETHER_MIRROR_REFUSAL);
  });
});
