import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import { firstNonEmptyLine } from "@t3tools/source-control-core/server/discovery";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import { encodeJson, encodeJsonEffect, processOutput, requiredChecksInput, requiredChecksPullRequest } from "./ForgejoSourceControlProvider.part2.testkit.ts";

it.effect("loads Forgejo pull request references from files and commits views", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    for (const reference of [
      "42",
      "#42",
      "https://forgejo.test/maria/project/pulls/42",
      "https://forgejo.test/maria/project/pulls/42/",
      "https://forgejo.test/maria/project/pulls/42/files?w=1#diff-1",
      "http://forgejo.test:3000/git/maria/project/pulls/42/commits",
    ]) {
      const result = yield* provider.getChangeRequest({ cwd: "/repo", reference });
      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Forgejo view reference");
      assert.strictEqual(result.headSha, "head");
    }
    const invalid = yield* provider
      .getChangeRequest({
        cwd: "/repo",
        reference: "https://forgejo.test/maria/project/pulls/42invalid/files",
      })
      .pipe(Effect.result);
    assert.strictEqual(invalid._tag, "Failure");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
        TestSourceControlHost.layer({ process: {} }),
        Layer.mock(ForgejoCli.ForgejoCli)({
          resolveRepository: () =>
            Effect.succeed({
              login: "work",
              repository: "maria/project",
              baseUrl: "https://forgejo.test",
            }),
          api: (input) => {
            assert.strictEqual(input.path, "repos/maria/project/pulls/42");
            return encodeJsonEffect({
              number: 42,
              title: "Forgejo view reference",
              html_url: "https://forgejo.test/maria/project/pulls/42",
              state: "open",
              merged: false,
              base: { ref: "main", sha: "base", repo: null },
              head: { ref: "feature", sha: "head", repo: null },
            }).pipe(Effect.orDie, Effect.map(processOutput));
          },
        }),
      ),
    ),
  ),
);

it.effect(
  "loads Forgejo reactions on comments, reviews and inline threads and resolves review mutations",
  () => {
    const user = { login: "maria" };
    const review = {
      id: 8,
      body: "review body",
      user,
      state: "COMMENT",
      submitted_at: "2026-09-12T00:00:00Z",
      html_url: "https://forgejo.test/maria/project/pulls/2#issuecomment-37",
      comments_count: 1,
    };
    const comment = { id: 12, body: "ordinary", user, created_at: review.submitted_at };
    const responses: Record<string, unknown> = {
      user,
      "repos/maria/project/issues/2/comments": [comment],
      "repos/maria/project/pulls/2/reviews": [review],
      "repos/maria/project/pulls/2/reviews/8": review,
      "repos/maria/project/pulls/2/reviews/9": { ...review, id: 9, html_url: "" },
      "repos/maria/project/pulls/2/commits": [],
      "repos/maria/project/issues/2/reactions": [],
      "repos/maria/project/pulls/2/reviews/8/comments": [
        {
          ...comment,
          id: 38,
          body: "inline",
          path: "file.ts",
          position: 1,
          original_position: 1,
          commit_id: "head",
          original_commit_id: "head",
          resolver: null,
        },
      ],
      "repos/maria/project/issues/comments/12/reactions": [{ content: "+1", user }],
      "repos/maria/project/issues/comments/37/reactions": [{ content: "heart", user }],
      "repos/maria/project/issues/comments/38/reactions": [
        { content: "rocket", user: { login: "reviewer" } },
      ],
    };
    const writes: ForgejoCli.ForgejoApiInput[] = [];
    let reactionReads = 0;
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const input = { cwd: "/repo", repository: "maria/project", host: "forgejo.test", number: 2 };
      const activity = yield* provider.getChangeRequestActivity(input);
      assert.deepStrictEqual(
        activity.comments.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          reactions: entry.reactions,
        })),
        [
          {
            id: "12",
            kind: "issue-comment",
            reactions: [{ content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true }],
          },
          {
            id: "review:8",
            kind: "review",
            reactions: [{ content: "heart", count: 1, actors: [], viewerHasReacted: true }],
          },
          {
            id: "38",
            kind: "review-comment",
            reactions: [
              { content: "rocket", count: 1, actors: ["reviewer"], viewerHasReacted: false },
            ],
          },
        ],
      );
      const inlineComment = activity.comments[2];
      assert.ok(inlineComment);
      assert.deepStrictEqual(activity.reviewThreads[0]?.comments, [inlineComment]);
      for (const reacted of [true, false]) {
        yield* provider.setReaction({ ...input, subjectId: "review:8", content: "heart", reacted });
        yield* provider.setReaction({ ...input, subjectId: "38", content: "rocket", reacted });
      }
      assert.deepStrictEqual(
        writes.map(({ path, method, body }) => ({ path, method, body })),
        [
          {
            path: "repos/maria/project/issues/comments/37/reactions",
            method: "POST",
            body: { content: "heart" },
          },
          {
            path: "repos/maria/project/issues/comments/38/reactions",
            method: "POST",
            body: { content: "rocket" },
          },
          {
            path: "repos/maria/project/issues/comments/37/reactions",
            method: "DELETE",
            body: { content: "heart" },
          },
          {
            path: "repos/maria/project/issues/comments/38/reactions",
            method: "DELETE",
            body: { content: "rocket" },
          },
        ],
      );
      const missing = yield* provider
        .setReaction({ ...input, subjectId: "review:9", content: "heart", reacted: true })
        .pipe(Effect.result);
      assert.strictEqual(missing._tag, "Failure");
      if (missing._tag === "Failure") assert.include(missing.failure.detail, "comment ID");
      assert.strictEqual(writes.length, 4);
      responses["repos/maria/project/pulls/2/reviews/8/comments"] = Array.from(
        { length: 501 },
        (_, index) => ({
          ...comment,
          id: 1000 + index,
          path: "file.ts",
          position: 1,
          original_position: 1,
          commit_id: "head",
          original_commit_id: "head",
          resolver: null,
        }),
      );
      for (let index = 0; index < 500; index++) {
        responses[`repos/maria/project/issues/comments/${1000 + index}/reactions`] = [];
      }
      reactionReads = 0;
      const bounded = yield* provider.getChangeRequestActivity(input);
      assert.strictEqual(bounded.reviewThreads.length, 500);
      assert.strictEqual(
        bounded.comments.filter((entry) => entry.kind === "review-comment").length,
        500,
      );
      assert.strictEqual(bounded.commentsTruncated, true);
      assert.strictEqual(reactionReads, 502);
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            if (input.method) {
              writes.push(input);
              return Effect.succeed(processOutput("{}"));
            }
            const path = input.path.split("?")[0]!;
            if (/\/issues\/comments\/\d+\/reactions$/.test(path)) reactionReads++;
            assert.ok(Object.hasOwn(responses, path), `Unexpected Forgejo request: ${path}`);
            const page = Number(new URLSearchParams(input.path.split("?")[1]).get("page"));
            return encodeJsonEffect(page > 1 ? [] : responses[path]).pipe(
              Effect.orDie,
              Effect.map(processOutput),
            );
          },
        }),
      ),
    );
  },
);

it.effect("lists each Forgejo assignee once as a reviewer candidate", () => {
  const paths: string[] = [];
  return Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const result = yield* provider.listReviewerCandidates(requiredChecksInput);
    assert.deepStrictEqual(
      result.candidates.map((candidate) => [candidate.id, candidate.isRequested]),
      [
        ["ana", true],
        ["noor", false],
      ],
    );
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(paths.filter((path) => path.includes("/assignees")).length, 1);
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          paths.push(input.path);
          const respond = (response: unknown) =>
            encodeJsonEffect(response).pipe(Effect.orDie, Effect.map(processOutput));
          switch (input.path.split("?")[0]) {
            case "repos/acme/web/pulls/7":
              return respond({
                ...requiredChecksPullRequest,
                requested_reviewers: [{ login: "ana" }],
              });
            // Forgejo ignores paging here: every page is the full list, with no Link header.
            case "repos/acme/web/assignees":
              return respond([{ login: "maria" }, { login: "ana" }, { login: "noor" }]);
            default:
              return Effect.die(`Unexpected Forgejo request: ${input.path}`);
          }
        },
      }),
    ),
  );
});

it.effect("discovers Forgejo accounts and retains the server port", () =>
  Effect.gen(function* () {
    const auth = ForgejoSourceControlProvider.discovery.parseAuth(
      processOutput(
        yield* encodeJsonEffect([
          {
            name: "work",
            url: "http://forgejo.local:3000",
            ssh_host: "git.forgejo.local",
            user: "maria",
            default: "true",
            valid: "true",
          },
        ]),
      ),
    );
    assert.deepStrictEqual(
      firstNonEmptyLine("\u001b[1mtea version 0.16.0\u001b[0m\n"),
      Option.some("tea version 0.16.0"),
    );
    assert.strictEqual(auth.status, "authenticated");
    assert.deepStrictEqual(auth.account, Option.some("maria"));
    assert.deepStrictEqual(auth.host, Option.some("forgejo.local:3000"));
    const revoked = ForgejoSourceControlProvider.discovery.parseAuth(
      processOutput(
        encodeJson([
          {
            name: "work",
            url: "http://forgejo.local:3000",
            user: "maria",
            default: "true",
            valid: "false",
          },
        ]),
      ),
    );
    assert.strictEqual(revoked.status, "unauthenticated");
    const refined = ForgejoSourceControlProvider.discovery.refineUnknownRemote({
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("unknown"),
          name: "git.forgejo.local",
          baseUrl: "https://git.forgejo.local",
        },
        remoteName: "origin",
        remoteUrl: "git@git.forgejo.local:maria/project.git",
      },
      auth: processOutput(
        yield* encodeJsonEffect([
          {
            name: "work",
            url: "http://forgejo.local:3000",
            ssh_host: "git.forgejo.local",
            user: "maria",
            default: "true",
          },
        ]),
      ),
    });
    assert.deepStrictEqual(refined, {
      kind: SourceControlProviderKind.make("forgejo"),
      name: "Forgejo / Gitea",
      baseUrl: "http://forgejo.local:3000",
    });
  }),
);

it.effect("does not choose a default Forgejo login across ambiguous SSH server ports", () =>
  Effect.gen(function* () {
    const logins = ForgejoCli.parseForgejoLogins(
      yield* encodeJsonEffect([
        {
          name: "one",
          url: "http://forgejo.local:3000",
          ssh_host: "forgejo.local",
          user: "maria",
          default: "true",
        },
        {
          name: "two",
          url: "http://forgejo.local:4000",
          ssh_host: "forgejo.local",
          user: "maria",
          default: "false",
        },
      ]),
    );
    const remote = ForgejoCli.parseForgejoRemote("git@forgejo.local:maria/project.git");
    assert.isNotNull(remote);
    assert.deepStrictEqual(
      ForgejoCli.parseForgejoRemote("forgejo.local:maria/project.git"),
      remote,
    );
    assert.isUndefined(ForgejoCli.matchForgejoLogin(logins, remote!));
    assert.strictEqual(
      ForgejoCli.matchForgejoLogin(logins, remote!, "forgejo.local:4000")?.name,
      "two",
    );
    assert.isUndefined(ForgejoCli.matchForgejoLogin(logins, remote!, "other.local:4000"));
    const alias = ForgejoCli.parseForgejoRemote("git@ssh.forgejo.local:maria/project.git");
    assert.isNotNull(alias);
    assert.isUndefined(ForgejoCli.matchForgejoLogin(logins, alias!, "forgejo.local:4000"));
    const refined = ForgejoSourceControlProvider.discovery.refineUnknownRemote({
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("unknown"),
          name: "Forgejo",
          baseUrl: "https://forgejo.local",
        },
        remoteName: "origin",
        remoteUrl: "git@forgejo.local:maria/project.git",
        requestedHost: "forgejo.local:4000",
      },
      auth: processOutput(yield* encodeJsonEffect(logins)),
    });
    assert.strictEqual(refined?.baseUrl, "http://forgejo.local:4000");
    const https = ForgejoCli.parseForgejoRemote("http://forgejo.local:4000/maria/project.git");
    assert.isNotNull(https);
    assert.strictEqual(ForgejoCli.matchForgejoLogin(logins, https!)?.name, "two");
    const hostOnly = ForgejoCli.parseForgejoRemote("http://forgejo.local:4000");
    assert.strictEqual(
      ForgejoCli.matchForgejoLogin(logins, hostOnly!, undefined, true)?.name,
      "two",
    );
    const mounted = logins.map((login) => ({
      ...login,
      url: `http://forgejo.local:4000/${login.name}`,
    }));
    assert.isUndefined(ForgejoCli.matchForgejoLogin(mounted, hostOnly!, undefined, true));
  }),
);

it.effect("rejects HTTP failures even when tea exits successfully", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const result = yield* cli
      .api({
        cwd: "/repo",
        repository: "http://forgejo.local:3000/maria/project",
        path: "repos/maria/project/pulls/42",
        method: "PATCH",
        body: { state: "closed" },
      })
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.strictEqual(
        result.failure.detail,
        "Forgejo repository or pull request was not found.",
      );
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(false),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        throw new Error("tea must handle its own HTTP request");
      }),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            if (input.args[0] === "api") {
              assert.strictEqual(input.stdin, '{"state":"closed"}');
              assert.include(input.args, "work");
              assert.include(
                input.args,
                "http://forgejo.local:3000/api/v1/repos/maria/project/pulls/42",
              );
            }
            return Effect.succeed(
              input.args[0] === "login"
                ? processOutput(
                    encodeJson([
                      {
                        name: "work",
                        url: "http://forgejo.local:3000",
                        ssh_host: "forgejo.local",
                        user: "maria",
                        default: "true",
                      },
                    ]),
                  )
                : processOutput('{"message":"not found"}', { stderr: "HTTP/1.1 404 Not Found\n" }),
            );
          },
        },
      }),
    ),
  ),
);
