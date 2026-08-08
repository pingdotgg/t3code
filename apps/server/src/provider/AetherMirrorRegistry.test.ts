import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { make } from "./AetherMirrorRegistry.ts";

describe("AetherMirrorRegistry", () => {
  it.effect("owns a cwd only while at least one claim is registered", () =>
    Effect.gen(function* () {
      const registry = yield* make;
      expect(yield* registry.ownsCwd("/repos/mirror")).toBe(false);

      yield* registry.register("/repos/mirror", "aether:thread-1");
      yield* registry.register("/repos/mirror", "aether:thread-2");
      expect(yield* registry.ownsCwd("/repos/mirror")).toBe(true);
      // Normalization: trailing slashes and dot segments hit the same claim.
      expect(yield* registry.ownsCwd("/repos/mirror/")).toBe(true);
      expect(yield* registry.ownsCwd("/repos/other/../mirror")).toBe(true);

      yield* registry.deregister("/repos/mirror", "aether:thread-1");
      expect(yield* registry.ownsCwd("/repos/mirror")).toBe(true);
      yield* registry.deregister("/repos/mirror", "aether:thread-2");
      expect(yield* registry.ownsCwd("/repos/mirror")).toBe(false);
    }),
  );

  it.effect("deregistering an unknown claim is a no-op, never an error", () =>
    Effect.gen(function* () {
      const registry = yield* make;
      yield* registry.deregister("/repos/never-registered", "aether:thread-9");
      expect(yield* registry.ownsCwd("/repos/never-registered")).toBe(false);
    }),
  );

  it.effect("removeWorktree bypass: a parent-repo cwd cannot hide a mirror target", () =>
    Effect.gen(function* () {
      const registry = yield* make;
      yield* registry.register("/repos/parent/.worktrees/aether-mirror", "aether:thread-1");

      // The dangerous call shape: cwd = ordinary parent repo, target path =
      // the active mirror (relative or absolute) — must be recognized.
      expect(yield* registry.ownsCwd("/repos/parent")).toBe(false);
      expect(yield* registry.ownsTargetPath("/repos/parent", ".worktrees/aether-mirror")).toBe(
        true,
      );
      expect(
        yield* registry.ownsTargetPath("/repos/parent", "/repos/parent/.worktrees/aether-mirror"),
      ).toBe(true);
      // git identifies a worktree by a UNIQUE last path component too:
      // `git worktree remove aether-mirror` from the parent deletes the
      // mirror even though the resolved path never matches the claim.
      expect(yield* registry.ownsTargetPath("/repos/parent", "aether-mirror")).toBe(true);
      expect(yield* registry.ownsTargetPath("/somewhere/else", "aether-mirror")).toBe(true);
      // A sibling worktree stays removable.
      expect(yield* registry.ownsTargetPath("/repos/parent", ".worktrees/other")).toBe(false);
    }),
  );

  it.effect("writeFile bypass: a parent-repo cwd cannot descend INTO a mirror", () =>
    Effect.gen(function* () {
      const registry = yield* make;
      yield* registry.register("/repos/parent/.worktrees/aether-mirror", "aether:thread-1");

      // projects.writeFile resolves relativePath under cwd — a parent cwd
      // reaching a file inside the mirror must be recognized as within it.
      expect(
        yield* registry.ownsPathWithin("/repos/parent", ".worktrees/aether-mirror/app.ts"),
      ).toBe(true);
      expect(
        yield* registry.ownsPathWithin(
          "/somewhere/else",
          "/repos/parent/.worktrees/aether-mirror/deep/nested.ts",
        ),
      ).toBe(true);
      // The mirror root itself counts; writes from the mirror cwd stay refused.
      expect(
        yield* registry.ownsPathWithin("/repos/parent/.worktrees/aether-mirror", "app.ts"),
      ).toBe(true);
      // Neighbours are untouched: a sibling file, and a path whose name
      // merely SHARES the mirror's prefix, both stay writable.
      expect(yield* registry.ownsPathWithin("/repos/parent", "src/app.ts")).toBe(false);
      expect(
        yield* registry.ownsPathWithin("/repos/parent", ".worktrees/aether-mirror-notes.md"),
      ).toBe(false);
    }),
  );
});
