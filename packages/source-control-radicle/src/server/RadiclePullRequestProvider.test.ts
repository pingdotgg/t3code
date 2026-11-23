import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { patchNumberFromId } from "../shared/definition.ts";
import * as RadiclePullRequestProvider from "./RadiclePullRequestProvider.ts";
import {
  AUTHOR,
  COMMENT,
  PATCH,
  REPLY,
  REVISION_2,
  RID,
  VIEWER,
  radicleLayer,
  type Run,
} from "./radicleTestFixtures.ts";

const ref = { cwd: "/repo", host: "radicle", repository: `rad:${RID.toLowerCase()}` };
const number = patchNumberFromId(PATCH);
const radArgs = (runs: ReadonlyArray<Run>, subcommand: string) =>
  runs.filter((run) => run.command === "rad" && run.args[0] === subcommand).map((run) => run.args);

it.effect(
  "lists patches with the ID-derived number, the author's alias and the explorer link",
  () => {
    const runs: Array<Run> = [];
    return Effect.gen(function* () {
      const provider = yield* RadiclePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...ref,
        state: "open",
        involvement: "all",
        viewer: `did:key:${VIEWER}`,
        limit: 10,
      });
      const [item] = page.items;
      assert.strictEqual(page.items.length, 1);
      assert.strictEqual(item?.number, number);
      assert.strictEqual(item?.author?.login, "author@laptop");
      assert.strictEqual(item?.headBranch, `patches/${PATCH}`);
      assert.strictEqual(item?.baseBranch, "main");
      assert.strictEqual(item?.reviewDecision, "approved");
      // The checkout's own ID keeps the case a lowercased selector lost.
      assert.strictEqual(
        item?.url,
        `https://radicle.network/nodes/seed.radicle.dev/rad:${RID}/patches/${PATCH}`,
      );
      const closed = yield* provider.listChangeRequests({
        ...ref,
        state: "closed",
        involvement: "all",
        viewer: `did:key:${VIEWER}`,
        limit: 10,
      });
      assert.strictEqual(closed.items.length, 0);
    }).pipe(Effect.provide(radicleLayer({ runs })));
  },
);

it.effect("reads conversations as threads, with replies under the comment they answer", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    const activity = yield* provider.getChangeRequestActivity({ ...ref, number });
    const [thread] = activity.overviewThreads ?? [];
    assert.strictEqual(thread?.id, COMMENT);
    assert.deepStrictEqual(
      thread?.comments.map((comment) => comment.id),
      [COMMENT, REPLY],
    );
    // The comments are on the first revision, which a second one superseded.
    assert.strictEqual(thread?.isOutdated, true);
    assert.strictEqual(thread?.comments[0]?.canEdit, true);
    const [review] = activity.comments;
    assert.strictEqual(review?.kind, "review");
    assert.strictEqual(review?.reviewState, "APPROVED");
    assert.strictEqual(review?.body, "Looks good");
    assert.strictEqual(activity.commentCount, 3);
    assert.strictEqual(activity.commits[0]?.committedDate, "2026-11-23T22:00:00.000Z");
  }).pipe(Effect.provide(radicleLayer({ runs })));
});

it.effect("reads the description, line counts and mergeability of the latest revision", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    const detail = yield* provider.getChangeRequest({ ...ref, number });
    assert.strictEqual(detail.body, "The description");
    assert.strictEqual(detail.headSha, "bbbb000000000000000000000000000000000002");
    assert.deepStrictEqual([detail.additions, detail.deletions, detail.changedFiles], [4, 1, 2]);
    assert.strictEqual(detail.mergeability, "mergeable");
    // The viewer is not a delegate here, so merging is withheld but commenting is not.
    assert.deepStrictEqual(detail.viewerPermissions.actions, []);
    assert.strictEqual(detail.viewerPermissions.comment, true);
    const storageRuns = runs.filter((run) => run.cwd === `/home/test/.radicle/storage/${RID}`);
    // The bare storage must be named, since the server refuses one found from the directory.
    assert.isTrue(storageRuns.length > 0);
    for (const run of storageRuns) {
      assert.deepStrictEqual(run.args.slice(0, 2), [
        "--git-dir",
        `/home/test/.radicle/storage/${RID}`,
      ]);
    }
    assert.isTrue(storageRuns.some((run) => run.args[2] === "merge-tree"));
  }).pipe(Effect.provide(radicleLayer({ runs })));
});

it.effect("reviews the latest revision with a verdict and comments on it otherwise", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    yield* provider.submitReview({
      ...ref,
      number,
      verdict: "approve",
      body: "Ship it",
      comments: [],
    });
    yield* provider.submitReview({
      ...ref,
      number,
      verdict: "comment",
      body: "Note",
      comments: [],
    });
    yield* provider.replyToThread({ ...ref, number, threadId: COMMENT, body: "Thanks" });
    assert.deepStrictEqual(radArgs(runs, "patch"), [
      [
        "patch",
        "review",
        PATCH,
        "--revision",
        REVISION_2,
        "--accept",
        "-m",
        "Ship it",
        "--repo",
        `rad:${RID}`,
      ],
      ["patch", "comment", REVISION_2, "-m", "Note", "--repo", `rad:${RID}`],
      ["patch", "comment", PATCH, "--reply-to", COMMENT, "-m", "Thanks", "--repo", `rad:${RID}`],
    ]);
  }).pipe(Effect.provide(radicleLayer({ runs })));
});

it.effect("closes and drafts with archive and ready --undo", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    yield* provider.runAction({ ...ref, number, action: "close" });
    yield* provider.runAction({ ...ref, number, action: "draft" });
    assert.deepStrictEqual(radArgs(runs, "patch"), [
      ["patch", "archive", PATCH, "--repo", `rad:${RID}`],
      ["patch", "ready", "--undo", PATCH, "--repo", `rad:${RID}`],
    ]);
  }).pipe(Effect.provide(radicleLayer({ runs })));
});

it.effect("leaves out a patch already delivered at the page boundary before the limit", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    const page = yield* provider.listChangeRequests({
      ...ref,
      state: "open",
      involvement: "all",
      viewer: "viewer@bridge",
      limit: 1,
      // The fixture patch was last updated 5 s after the epoch.
      cursor: { updatedBefore: "1970-01-01T00:00:05.000Z", delivered: 1, seenAt: [number] },
    });
    assert.deepStrictEqual(page.items, []);
    assert.strictEqual(page.truncated, false);
  }).pipe(Effect.provide(radicleLayer({ runs })));
});

it.effect("refuses to merge for someone who is not a delegate, before touching git", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    const exit = yield* provider.runAction({ ...ref, number, action: "merge" }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    assert.isFalse(runs.some((run) => run.command === "git" && run.args[0] === "push"));
  }).pipe(Effect.provide(radicleLayer({ runs, delegates: [AUTHOR] })));
});

it.effect("merges in the checkout and pushes the merge as the default branch", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    yield* provider.runAction({ ...ref, number, action: "merge", mergeMethod: "merge" });
    const git = runs.filter((run) => run.command === "git" && run.cwd === "/repo");
    assert.deepStrictEqual(
      git.map((run) => run.args[0]),
      ["remote", "fetch", "rev-parse", "merge-tree", "commit-tree", "push"],
    );
    assert.deepStrictEqual(git.at(-1)?.args, ["push", "rad", "merge-commit:refs/heads/main"]);
    assert.strictEqual(
      git[4]?.args.slice(2, 6).join(" "),
      "-p base-sha -p bbbb000000000000000000000000000000000002",
    );
  }).pipe(
    Effect.provide(
      radicleLayer({
        runs,
        delegates: [AUTHOR, VIEWER],
        answer: (input) =>
          input.command !== "git" || input.cwd !== "/repo"
            ? undefined
            : input.args[0] === "fetch" || input.args[0] === "push"
              ? ""
              : input.args[0] === "rev-parse"
                ? "base-sha\n"
                : input.args[0] === "commit-tree"
                  ? "merge-commit\n"
                  : undefined,
      }),
    ),
  );
});
