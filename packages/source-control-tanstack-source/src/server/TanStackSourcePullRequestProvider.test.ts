import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

import * as TanStackSourceApi from "./TanStackSourceApi.ts";
import * as Credentials from "./TanStackSourceCredentials.ts";
import * as TanStackSourcePullRequestProvider from "./TanStackSourcePullRequestProvider.ts";

const HOST = "source.tanstack.com";

/**
 * Shaped like `GET /pulls/{n}` of a private pull request: its head is `owner:branch` in the
 * companion repository, and Source has stored no file or line counts for it.
 */
const PRIVATE_PULL = {
  number: 42,
  title: "Fix the thing",
  state: "open",
  visibility: "private",
  draft: false,
  author: "bob",
  head: "acme:fix/thing",
  createdAt: 1_000,
  body: null,
  base: "main",
  headRepo: "acme/web.private",
  headSha: "c".repeat(40),
  baseSha: "b".repeat(40),
  mergeCommitSha: null,
  mergedAt: null,
  mergedBy: null,
  mergeable: null,
  changedFiles: null,
  changedLines: null,
};

const FILES = {
  baseSha: "b".repeat(40),
  headSha: "c".repeat(40),
  mergeBaseSha: "b".repeat(40),
  available: true,
  truncated: false,
  files: [
    { path: "a.ts", status: "modified", additions: 3, deletions: 1 },
    { path: "b.ts", status: "added", additions: 4, deletions: 0 },
  ],
};

const RESPONSES: Record<string, unknown> = {
  "/repos/acme/web/pulls/42": PRIVATE_PULL,
  "/repos/acme/web/pulls/42/files": FILES,
  "/repos/acme/web/pulls/42/checks": { checks: [], upToDate: null, mayMerge: true },
  "/repos/acme/web/pulls/42/stack": { members: [] },
  [`/repos/acme/web/check-runs?sha=${"c".repeat(40)}`]: [],
  "/repos/acme/web/ci/runs?pull=42&limit=30": { items: [], next: null },
  "/repos/acme/web/issues/42": {
    timeline: [
      { id: 1, comment: "Looks good", author: "alice", at: 2_000 },
      { event: "head_updated", actor: "bob", at: 3_000 },
    ],
    next: null,
  },
  "/repos/acme/web/pulls/42/comments": [],
  "/repos/acme/web/pulls/42/commits": {
    baseSha: null,
    headSha: null,
    mergeBaseSha: null,
    available: true,
    commits: [],
  },
  "/user": { username: "alice" },
};

const api = TanStackSourceApi.TanStackSourceApi.of({
  request: (input) =>
    input.path in RESPONSES
      ? Effect.succeed(JSON.stringify(RESPONSES[input.path]))
      : Effect.die(`unexpected ${input.path}`),
  response: () => Effect.die("unexpected response read"),
});

const provider = TanStackSourcePullRequestProvider.make.pipe(
  Effect.provideService(TanStackSourceApi.TanStackSourceApi, api),
  Effect.provideService(
    Credentials.TanStackSourceCredentials,
    Credentials.TanStackSourceCredentials.of({
      get: () => Effect.die("unexpected credential read"),
      invalidate: () => Effect.void,
    }),
  ),
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected http request")),
  ),
);

describe("TanStackSourcePullRequestProvider.getChangeRequest", () => {
  // A client without this host's definition percent-encodes the owner's `@`; stored links
  // keep the web's own spelling.
  it.effect.each(["acme/web", "@acme/web", "%40acme/web"])(
    "reads a private pull request of %s",
    (repository) =>
      Effect.gen(function* () {
        const detail = yield* (yield* provider).getChangeRequest({
          host: HOST,
          repository,
          number: 42,
          cwd: "/repo",
        });
        assert.strictEqual(detail.url, `https://${HOST}/@acme/web/pull/42`);
        assert.strictEqual(detail.visibility, "private");
        assert.strictEqual(detail.headBranch, "fix/thing");
        assert.strictEqual(detail.headRepositoryNameWithOwner, "acme/web.private");
        // Source stores no counts for it, so they come from its files.
        assert.deepStrictEqual(
          [detail.changedFiles, detail.additions, detail.deletions],
          [2, 7, 1],
        );
      }),
  );
});

describe("TanStackSourcePullRequestProvider.getChangeRequestActivity", () => {
  it.effect("reads the comments of a timeline that also holds events", () =>
    Effect.gen(function* () {
      const activity = yield* (yield* provider).getChangeRequestActivity({
        host: HOST,
        repository: "acme/web",
        number: 42,
        cwd: "/repo",
      });
      assert.deepStrictEqual(
        activity.comments.map((comment) => comment.body),
        ["Looks good"],
      );
    }),
  );
});
