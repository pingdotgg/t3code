import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  AETHER_MIRROR_REFUSAL,
  aetherMirrorWriteFileError,
  guardAetherRemoveWorktree,
  guardAetherVcsMutation,
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

  it("aetherMirrorWriteFileError carries the refusal as its message", () => {
    const error = aetherMirrorWriteFileError({ cwd: "/repos/mirror", relativePath: "src/a.ts" });
    expect(error._tag).toBe("ProjectWriteFileError");
    expect(error.failure).toBe("aether_mirror_read_only");
    // The message is derived from the aether_mirror_read_only failure literal —
    // the web UI renders exactly this text.
    expect(error.message).toBe(AETHER_MIRROR_REFUSAL);
  });
});
