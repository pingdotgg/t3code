import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe, expect } from "vitest";

import { runProcess } from "../processRunner.ts";
import { CheckoutCoordinatorLive, CheckoutCoordinator } from "./CheckoutCoordinator.ts";

async function git(cwd: string, args: ReadonlyArray<string>): Promise<void> {
  const result = await runProcess("git", ["-C", cwd, ...args], {
    allowNonZeroExit: true,
    timeoutMs: 10_000,
    maxBufferBytes: 32 * 1024,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Checkout Coordinator Test",
      GIT_AUTHOR_EMAIL: "checkout-coordinator@example.test",
      GIT_COMMITTER_NAME: "Checkout Coordinator Test",
      GIT_COMMITTER_EMAIL: "checkout-coordinator@example.test",
    },
  });
  if (result.code !== 0) throw new Error(result.stderr.trim());
}

it.layer(CheckoutCoordinatorLive)("CheckoutCoordinator", (it) => {
  describe("withCheckoutUnlessSameRoot", () => {
    it.effect("avoids re-locking the source root but locks cwd for a separate worktree", () =>
      Effect.gen(function* () {
        const fixtureRoot = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), "t3-checkout-coordinator-"))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const repositoryRoot = path.join(fixtureRoot, "repo");
        const separateWorktree = path.join(fixtureRoot, "separate-worktree");
        yield* Effect.promise(() => mkdir(repositoryRoot));
        yield* Effect.promise(() => git(repositoryRoot, ["init", "-b", "main"]));
        yield* Effect.promise(() => writeFile(path.join(repositoryRoot, "README.md"), "fixture\n"));
        yield* Effect.promise(() => git(repositoryRoot, ["add", "README.md"]));
        yield* Effect.promise(() => git(repositoryRoot, ["commit", "-m", "fixture"]));
        yield* Effect.promise(() =>
          git(repositoryRoot, ["worktree", "add", "-b", "separate", separateWorktree, "HEAD"]),
        );

        const coordinator = yield* CheckoutCoordinator;
        const sameCheckout = yield* coordinator.withCheckoutUnlessSameRoot(
          repositoryRoot,
          repositoryRoot,
          coordinator.tryWithCheckout(repositoryRoot, Effect.succeed("source lock available")),
        );
        expect(Option.isSome(sameCheckout)).toBe(true);

        const separateCheckouts = yield* coordinator.withCheckoutUnlessSameRoot(
          repositoryRoot,
          separateWorktree,
          Effect.gen(function* () {
            return {
              cwd: yield* coordinator.tryWithCheckout(repositoryRoot, Effect.succeed("locked")),
              source: yield* coordinator.tryWithCheckout(
                separateWorktree,
                Effect.succeed("independent source lock"),
              ),
            };
          }),
        );
        expect(Option.isNone(separateCheckouts.cwd)).toBe(true);
        expect(Option.isSome(separateCheckouts.source)).toBe(true);
      }),
    );
  });
});
