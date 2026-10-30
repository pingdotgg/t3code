import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

it.effect("reads file revisions from the pull request diff and refuses a truncated one", () =>
  Effect.gen(function* () {
    let truncated = false;
    const diff = [
      "diff --git a/alpha.ts b/alpha.ts",
      "index eb2d7c5..b485fe5 100644",
      "diff --git a/beta.ts b/beta.ts",
      "index b39e8b3..5851425 100644",
      'diff --git "a/caf\\303\\251 notes.txt" "b/caf\\303\\251 notes.txt"',
      "index ffd99ce..6dd9855 100644",
      "diff --git a/deleted.txt b/deleted.txt",
      "deleted file mode 100644",
      "index 233f5c6..0000000",
      "diff --git a/old.txt b/renamed.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to renamed.txt",
      "",
    ].join("\n");
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            assert.strictEqual(input.host, "forge.example:3000");
            assert.strictEqual(input.repository, "reviewer/project");
            assert.strictEqual(input.path, "repos/reviewer/project/pulls/1.diff");
            return Effect.succeed({
              ...TestSourceControlHost.processOutput(diff),
              stdoutTruncated: truncated,
            });
          },
        }),
      ),
    );
    const reference = {
      cwd: "/forgejo",
      repository: "reviewer/project",
      host: "forge.example:3000",
      number: 1,
    };
    const paths = ["alpha.ts", "beta.ts", "café notes.txt", "deleted.txt", "renamed.txt"];
    assert.isDefined(provider.getFileRevisions);
    const answer = yield* provider.getFileRevisions!({ ...reference, paths });
    assert.isTrue(answer.complete);
    assert.deepStrictEqual(
      paths.map((path) => [path, answer.revisions.get(path)]),
      [
        ["alpha.ts", "b485fe5"],
        ["beta.ts", "5851425"],
        ["café notes.txt", "6dd9855"],
        ["deleted.txt", "0000000"],
        ["renamed.txt", ""],
      ],
    );

    truncated = true;
    const refused = yield* Effect.flip(provider.getFileRevisions!({ ...reference, paths }));
    assert.strictEqual(refused._tag, "PullRequestProviderError");
  }),
);

it.effect.each([
  {
    reply: JSON.stringify({
      number: 1,
      title: "Close me",
      body: null,
      html_url: "https://forge.example/reviewer/project/pulls/1",
      user: { login: "alice" },
      state: "closed",
      merged: false,
      head: { ref: "feature", sha: "abc123", repo: null },
      base: { ref: "main", sha: "def456", repo: null },
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
      closed_at: "2026-07-02T00:00:00Z",
      merged_at: null,
      labels: null,
    }),
  },
  { reply: "" },
])("returns the pull request Forgejo's PATCH replied with, if any", ({ reply }) =>
  Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: () => Effect.succeed(TestSourceControlHost.processOutput(reply)),
        }),
      ),
    );
    const summary = yield* provider.runAction({
      cwd: "/forgejo",
      repository: "reviewer/project",
      host: "forge.example",
      number: 1,
      action: "close",
    });
    if (reply === "") return assert.isUndefined(summary);
    assert.deepInclude(summary, {
      state: "closed",
      closedAt: "2026-07-02T00:00:00.000Z",
      headSha: "abc123",
      additions: undefined,
    });
    assert.notProperty(summary, "mergeability");
  }),
);
