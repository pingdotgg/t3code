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

it.effect("filters listed pull requests by the requested state", () =>
  Effect.gen(function* () {
    // Forgejo answers a `state=closed` query with merged and closed-unmerged rows alike.
    const rows = [true, false].map((merged) => ({
      number: merged ? 1 : 2,
      title: `Pull request ${merged ? 1 : 2}`,
      body: "",
      html_url: `https://forge.example:3000/maria/project/pulls/${merged ? 1 : 2}`,
      user: { login: "maria" },
      state: "closed",
      merged,
      head: { ref: "feature", sha: "head-sha", repo: null },
      base: { ref: "main", sha: "base-sha", repo: null },
      created_at: "2026-10-12T00:00:00Z",
      updated_at: "2026-10-12T00:00:00Z",
      closed_at: "2026-10-13T00:00:00Z",
      merged_at: merged ? "2026-10-13T00:00:00Z" : null,
      labels: [],
    }));
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            const [path, query] = input.path.split("?");
            assert.strictEqual(path, "repos/maria/project/pulls");
            const params = new URLSearchParams(query);
            // A merged list asks Forgejo for closed rows and separates them itself.
            const state = params.get("state");
            assert.ok(state === "closed" || state === "open" || state === "all");
            const page = params.get("page") === "1" && state !== "open" ? rows : [];
            return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(page)));
          },
        }),
      ),
    );
    const input = {
      cwd: "/forgejo",
      repository: "maria/project",
      host: "forge.example:3000",
      involvement: "all" as const,
      viewer: "maria",
      limit: 10,
    };
    const numbers = (state: "open" | "closed" | "merged" | "all") =>
      provider
        .listChangeRequests({ ...input, state })
        .pipe(Effect.map((page) => page.items.map((item) => item.number)));

    assert.deepStrictEqual(yield* numbers("merged"), [1]);
    assert.deepStrictEqual(yield* numbers("closed"), [2]);
    assert.deepStrictEqual(yield* numbers("all"), [1, 2]);
    assert.deepStrictEqual(yield* numbers("open"), []);
  }),
);
