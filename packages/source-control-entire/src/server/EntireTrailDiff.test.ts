import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as EntirePullRequestProvider from "./EntirePullRequestProvider.ts";
import * as Fixtures from "./entireFixtures.ts";
import { commit, makeTrailRepository, realGit, run } from "./entireGitFixture.ts";
import { fakeEntire, type SentRequest } from "./entireTestServer.ts";

const target = { cwd: "", host: "entire.io", repository: "gh/acme/web", number: 7 };

function timeline(commits: ReadonlyArray<string>) {
  return {
    items: commits.map((commitSha, index) => ({
      id: `commit-${index}`,
      kind: "commit",
      occurredAt: null,
      commitSha,
    })),
  };
}

function changedPaths(patch: string): ReadonlyArray<string> {
  return [...patch.matchAll(/^diff --git a\/(\S+) b\//gmu)].map((match) => match[1] ?? "");
}

describe("Entire trail diffs", () => {
  it.effect("diff an open trail from where it left its base, fetching the head", () => {
    const repository = makeTrailRepository();
    const checkout = repository.clone();
    const server = fakeEntire(
      { "GET /trails/7": { ...Fixtures.detail, head_sha: repository.head } },
      { git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const input = { ...target, cwd: checkout };
      const diff = yield* provider.getDiff(input);
      assert.deepStrictEqual(changedPaths(diff.patch), ["a.txt", "b.txt"]);
      assert.isFalse(diff.truncated);

      const contents = yield* provider.getDiffFileContents!({
        ...input,
        changeType: "change",
        oldPath: "a.txt",
        newPath: "a.txt",
      });
      assert.deepStrictEqual(contents, { oldContents: "one\n", newContents: "two\n" });
      // Expanding a file reuses the fetch the patch made.
      assert.strictEqual(server.sent.length, 1);
      // The trail is read from remote-tracking refs; no local branch is created or moved.
      assert.strictEqual(run(checkout, "branch", "--format=%(refname:short)"), "main");
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("refuses to show a file larger than git's output limit as if it were whole", () => {
    const repository = makeTrailRepository();
    const checkout = repository.clone();
    const server = fakeEntire(
      { "GET /trails/7": { ...Fixtures.detail, head_sha: repository.head } },
      {
        git: {
          ...realGit,
          execute: (input) =>
            realGit.execute!(input).pipe(
              Effect.map((result) =>
                input.args[0] === "cat-file" ? { ...result, stdoutTruncated: true } : result,
              ),
            ),
        },
      },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const error = yield* provider.getDiffFileContents!({
        ...target,
        cwd: checkout,
        changeType: "change",
        oldPath: "a.txt",
        newPath: "a.txt",
      }).pipe(Effect.flip);
      assert.include(error.detail, "a.txt");
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("diff a trail merged with a merge commit from where it began", () => {
    const repository = makeTrailRepository();
    run(repository.work, "merge", "--quiet", "--no-ff", "--message", "Merge trail", "feature");
    commit(repository.work, { "d.txt": "after\n" }, "after the merge");
    run(repository.work, "push", "--quiet", "origin", "main");
    const checkout = repository.clone();
    const server = fakeEntire(
      {
        "GET /trails/7": { ...Fixtures.detail, status: "merged", head_sha: repository.head },
        "GET /trails/7/timeline": timeline([repository.head]),
      },
      { git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const diff = yield* provider.getDiff({ ...target, cwd: checkout });
      assert.deepStrictEqual(changedPaths(diff.patch), ["a.txt", "b.txt"]);
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("diff a rebased, fast-forwarded trail from its last fork point", () => {
    const repository = makeTrailRepository();
    run(repository.work, "rebase", "--quiet", "main", "feature");
    const head = run(repository.work, "rev-parse", "HEAD");
    run(repository.work, "switch", "--quiet", "main");
    run(repository.work, "merge", "--quiet", "--ff-only", "feature");
    run(repository.work, "push", "--quiet", "origin", "main");
    const checkout = repository.clone();
    const server = fakeEntire(
      {
        "GET /trails/7": { ...Fixtures.detail, status: "merged", head_sha: head },
        // The pre-rebase commit stays on the timeline but no longer leads to the head.
        "GET /trails/7/timeline": timeline([repository.head, head]),
      },
      { git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const diff = yield* provider.getDiff({ ...target, cwd: checkout });
      assert.deepStrictEqual(changedPaths(diff.patch), ["a.txt", "b.txt"]);
      assert.notInclude(diff.patch, "c.txt");
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("diff a merged trail from the commit its timeline's later pages name first", () => {
    const repository = makeTrailRepository();
    run(repository.work, "switch", "--quiet", "feature");
    const head = commit(repository.work, { "d.txt": "more\n" }, "trail again");
    run(repository.work, "switch", "--quiet", "main");
    run(repository.work, "merge", "--quiet", "--no-ff", "--message", "Merge trail", "feature");
    run(repository.work, "push", "--quiet", "origin", "main");
    const checkout = repository.clone();
    const server = fakeEntire(
      {
        "GET /trails/7": { ...Fixtures.detail, status: "merged", head_sha: head },
        "GET /trails/7/timeline": (request: SentRequest) =>
          request.query.get("pageToken") === "older"
            ? timeline([repository.head])
            : { ...timeline([head]), nextPageToken: "older" },
      },
      { git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const diff = yield* provider.getDiff({ ...target, cwd: checkout });
      assert.deepStrictEqual(changedPaths(diff.patch), ["a.txt", "b.txt", "d.txt"]);
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("refuses to guess where a merged trail began from a timeline it can't finish", () => {
    const repository = makeTrailRepository();
    run(repository.work, "merge", "--quiet", "--no-ff", "--message", "Merge trail", "feature");
    run(repository.work, "push", "--quiet", "origin", "main");
    const checkout = repository.clone();
    let page = 0;
    const server = fakeEntire(
      {
        "GET /trails/7": { ...Fixtures.detail, status: "merged", head_sha: repository.head },
        "GET /trails/7/timeline": () => ({
          ...timeline([repository.head]),
          nextPageToken: `page-${++page}`,
        }),
      },
      { git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const error = yield* provider.getDiff({ ...target, cwd: checkout }).pipe(Effect.flip);
      assert.include(error.detail, "too long");
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("diff from the merge base Entire recorded, without reading the timeline", () => {
    const repository = makeTrailRepository();
    run(repository.work, "merge", "--quiet", "--no-ff", "--message", "Merge trail", "feature");
    run(repository.work, "push", "--quiet", "origin", "main");
    const checkout = repository.clone();
    const server = fakeEntire(
      {
        "GET /trails/7": {
          ...Fixtures.detail,
          status: "merged",
          head_sha: repository.head,
          merge_base_sha: repository.base,
        },
      },
      { git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const diff = yield* provider.getDiff({ ...target, cwd: checkout });
      assert.deepStrictEqual(changedPaths(diff.patch), ["a.txt", "b.txt"]);
      assert.deepStrictEqual(
        server.sent.map((request) => request.path),
        ["/trails/7"],
      );
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("diff one of the trail's commits against its parent", () => {
    const repository = makeTrailRepository();
    const checkout = repository.clone();
    const server = fakeEntire(
      { "GET /trails/7": { ...Fixtures.detail, head_sha: repository.head } },
      { git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const diff = yield* provider.getDiff({
        ...target,
        cwd: checkout,
        commit: repository.head,
      });
      assert.deepStrictEqual(changedPaths(diff.patch), ["a.txt", "b.txt"]);
      const unknown = yield* provider
        .getDiff({ ...target, cwd: checkout, commit: "f".repeat(40) })
        .pipe(Effect.flip);
      assert.strictEqual(unknown.reason, "failed");
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("names each file's blob at the head shown, so viewed marks follow its changes", () => {
    const repository = makeTrailRepository();
    const checkout = repository.clone();
    const server = fakeEntire(
      { "GET /trails/7": { ...Fixtures.detail, head_sha: repository.head } },
      { git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const answer = yield* provider.getFileRevisions!({
        ...target,
        cwd: checkout,
        paths: ["a.txt", "gone.txt"],
      });
      assert.deepStrictEqual(Object.fromEntries(answer.revisions), {
        "a.txt": run(checkout, "rev-parse", `${repository.head}:a.txt`),
        "b.txt": run(checkout, "rev-parse", `${repository.head}:b.txt`),
        "gone.txt": "",
      });
      assert.isTrue(answer.complete);
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("counts the trail's files, fetching only what the checkout lacks", () => {
    const repository = makeTrailRepository();
    const checkout = repository.clone();
    let fetches = 0;
    const server = fakeEntire(
      { "GET /trails/7": { ...Fixtures.detail, head_sha: repository.head } },
      {
        git: {
          ...realGit,
          execute: (input) => {
            if (input.args[0] === "fetch") fetches++;
            return realGit.execute!(input);
          },
          fetchRemoteTrackingBranch: (input) => {
            fetches++;
            return realGit.fetchRemoteTrackingBranch!(input);
          },
        },
      },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const input = { ...target, cwd: checkout };
      // The checkout lacks the trail's head, but already tracks its base.
      assert.strictEqual((yield* provider.getChangeRequest(input)).changedFiles, 2);
      assert.strictEqual(fetches, 1);
      yield* provider.getChangeRequest(input);
      yield* TestClock.adjust("31 seconds");
      assert.strictEqual((yield* provider.getChangeRequest(input)).changedFiles, 2);
      assert.strictEqual(fetches, 1);
      // The diff brings the base up to date.
      yield* provider.getDiff(input);
      assert.strictEqual(fetches, 2);
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("refuse a checkout whose remote is not the trail's repository", () => {
    const repository = makeTrailRepository();
    const checkout = repository.clone();
    const server = fakeEntire(
      { "GET /trails/7": { ...Fixtures.detail, head_sha: repository.head } },
      { remoteUrl: "git@github.com:acme/web.git", git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const error = yield* provider.getDiff({ ...target, cwd: checkout }).pipe(Effect.flip);
      assert.include(error.detail, "no entire:// remote");
      assert.notInclude(run(checkout, "branch", "--remotes"), "feature");
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });
});
