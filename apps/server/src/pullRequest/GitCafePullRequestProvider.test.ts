import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitCafeCli from "../sourceControl/GitCafeCli.ts";
import { gitCafeViewerPermissions, make } from "./GitCafePullRequestProvider.ts";

const target = { cwd: "/work", host: "git.cafe", repository: "owner/repo", number: 7 };
const time = "2026-09-12T12:00:00.000Z";
const actor = {
  kind: "local",
  actorId: "act_author",
  handle: "author",
  displayName: null,
  avatarUrl: "/avatars/one",
};
const pull = {
  id: "pr_one",
  number: 7,
  title: "Change",
  state: "open",
  draft: false,
  sourceBranch: "feature",
  targetBranch: "main",
  headOid: "abcdef",
  author: actor,
  createdAt: time,
  updatedAt: time,
  version: 1,
  labels: [],
};
const detail = {
  ...pull,
  description: "Body",
  sourceRepo: null,
  observedBaseOid: "baseabcdef",
  mergeRoute: "native",
  closedAt: null,
  mergedAt: null,
  capabilities: { comment: false, review: true, merge: true, edit: true, moderate: true },
};
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const revision = { version: 1, headOid: "abcdef", comparisonBaseOid: "baseabcdef" };
const hunk = {
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  lines: [
    { origin: "-", content: "old\n" },
    { origin: "+", content: "new\n" },
  ],
};
type Request = Parameters<GitCafeCli.GitCafeCli["Service"]["api"]>[0];
const withApi = (respond: (input: Request) => unknown) =>
  Layer.mock(GitCafeCli.GitCafeCli)({ api: (input) => Effect.sync(() => json(respond(input))) });

describe("deployed GitCafe PR API", () => {
  it("maps merge permission to stack rebases without enabling standalone branch updates", () => {
    const permissions = gitCafeViewerPermissions({
      ...detail,
      state: "open" as const,
      author: { ...detail.author, kind: "local" as const },
      mergeRoute: "native" as const,
      capabilities: { comment: false, review: true, merge: true, edit: true, moderate: false },
    });
    expect(permissions.editChangeRequest).toBe(true);
    expect(permissions.requestReviewers).toBe(false);
    expect(permissions.labels).toBe(false);
    expect(permissions.actions).not.toContain("update-branch");
    expect(permissions.stackRebase).toBe(true);
  });

  it("offers independently authorized comments without granting review verdicts", () => {
    const permissions = gitCafeViewerPermissions({
      ...detail,
      state: "open",
      author: { ...detail.author, kind: "local" },
      mergeRoute: "native",
      capabilities: { comment: false, review: false, merge: false, edit: false, moderate: false },
    });
    expect(permissions.comment).toBe(true);
    expect(permissions.verdicts).toEqual([]);
    expect(permissions.actions).toEqual([]);
  });

  it.effect.each([
    ["merged", 404, true],
    ["closed", 404, true],
    ["open", 404, false],
    ["merged", 503, false],
  ] as const)(
    "handles unavailable source statistics for %s PRs with HTTP %s",
    ([state, status, succeeds]) =>
      Effect.gen(function* () {
        const provider = yield* make;
        const result = yield* provider.getChangeRequest(target).pipe(Effect.result);
        expect(result._tag).toBe(succeeds ? "Success" : "Failure");
        if (result._tag === "Success") {
          expect(result.success.body).toBe("Body");
          expect(result.success.state).toBe(state);
          expect(result.success.changedFiles).toBe(0);
          expect(result.success.additions).toBe(0);
        }
      }).pipe(
        Effect.provide(
          Layer.mock(GitCafeCli.GitCafeCli)({
            api: (input) => {
              if (input.endpoint.includes("/changes?"))
                return Effect.fail(
                  new GitCafeCli.GitCafeCliError({
                    command: "cafe",
                    cwd: target.cwd,
                    code: "SOURCE_FAILED",
                    status,
                    detail: "Git source request failed",
                  }),
                );
              if (input.endpoint.includes("/reviewers?"))
                return Effect.succeed(json({ items: [], next: null }));
              if (input.endpoint.includes("/labels?")) return Effect.succeed(json({ items: [] }));
              if (input.endpoint.includes("/commits/")) return Effect.succeed(json({ items: [] }));
              if (input.endpoint.endsWith("/status"))
                return Effect.succeed(
                  json({
                    merge: { conflicts: "unknown", fastForward: null, strategies: [] },
                    checks: { pending: 0, failing: 0, successful: 0, total: 0 },
                  }),
                );
              return Effect.succeed(json({ ...detail, state }));
            },
          }),
        ),
      ),
  );

  it.effect("decodes flat linked PR details without loading activity", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const summary = yield* provider.getChangeRequestSummary!(target);
      expect(summary.title).toBe("Change");
      expect(summary.author?.avatarUrl).toBe("https://git.cafe/avatars/one");
      expect(calls).toHaveLength(1);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          return detail;
        }),
      ),
    );
  });
  it.effect("keeps staging API requests and displayed identities on the repository host", () => {
    const calls: Request[] = [];
    const staging = { ...target, host: "staging.git.cafe" };
    return Effect.gen(function* () {
      const provider = yield* make;
      expect(yield* provider.getViewer(staging)).toBe("staging-user");
      const summary = yield* provider.getChangeRequestSummary!(staging);
      expect(summary.url).toBe("https://staging.git.cafe/owner/repo/pulls/7");
      expect(summary.author?.avatarUrl).toBe("https://staging.git.cafe/avatars/one");
      yield* provider.getChangeRequestActivity(staging);
      const stack = yield* provider.getChangeRequestStack!(staging);
      expect(stack?.url).toBe("https://staging.git.cafe/owner/repo/stacks/2");
      expect(calls.length).toBeGreaterThan(3);
      expect(calls.every((call) => call.host === "staging.git.cafe")).toBe(true);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          if (input.endpoint === "/auth/principal") return { handle: "staging-user" };
          if (input.endpoint.endsWith("/stack"))
            return {
              stack: { id: "stack", number: 2, revision: 1, landingBase: "main", members: [] },
            };
          if (input.endpoint.includes("/commits?"))
            return { items: [], truncated: false, next: null, headOid: "abcdef" };
          if (input.endpoint.includes("/comments?") || input.endpoint.includes("/reviews?"))
            return { items: [], next: null };
          return detail;
        }),
      ),
    );
  });
  it.effect("continues bounded creation-ordered pages using after, never offset", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "all",
        viewer: "author",
        limit: 101,
      });
      expect(page.items).toHaveLength(101);
      expect(page).toMatchObject({ truncated: true, continues: false });
      const query = new URL(calls[1]!.endpoint, "https://git.cafe").searchParams;
      expect(query.get("after")).toBe("pr_cursor");
      expect(query.get("sort")).toBe("newest");
      expect(query.get("state")).toBe("open");
      expect(query.has("offset")).toBe(false);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          const limit = Number(
            new URL(input.endpoint, "https://git.cafe").searchParams.get("limit"),
          );
          return {
            items: Array.from({ length: limit }, (_, i) => ({ ...pull, number: i + 1 })),
            next: "pr_cursor",
          };
        }),
      ),
    );
  });
  it.effect("uses native authors filter before pagination", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      yield* provider.listChangeRequests({
        ...target,
        state: "all",
        involvement: "authored",
        viewer: "Author",
        limit: 1,
      });
      expect(new URL(calls[1]!.endpoint, "https://git.cafe").searchParams.get("authors")).toBe(
        '["act_author"]',
      );
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          return input.endpoint.endsWith("/filter-options")
            ? { actors: [{ actorId: "act_author", handle: "author" }] }
            : { items: [pull], next: null };
        }),
      ),
    );
  });
  it.effect("uses the native reviewer filter without per-PR reads", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "reviewing",
        viewer: "author",
        limit: 100,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.reviewRequestLogins).toContain("author");
      expect(calls).toHaveLength(2);
      expect(new URL(calls[1]!.endpoint, "https://git.cafe").searchParams.get("reviewers")).toBe(
        '["act_author"]',
      );
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          return input.endpoint.endsWith("/filter-options")
            ? { actors: [{ actorId: "act_author", handle: "author" }] }
            : { items: [pull], next: null };
        }),
      ),
    );
  });
  it.effect("reads detailed diff statistics and checks without loading comments", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getChangeRequest(target);
      expect(result.changedFiles).toBe(1);
      expect(result.additions).toBe(7);
      expect(result.deletions).toBe(2);
      expect(result.mergeability).toBe("unknown");
      expect(result.viewerPermissions.actions).toEqual(["draft", "close", "merge"]);
      // The detail fixture reports comment=false, as production does for CLI grants even
      // when their independent conversation-comment scope authorizes the write.
      expect(result.viewerPermissions.comment).toBe(true);
      expect(result.checks).toEqual([
        { name: "CI", status: "failure", description: "Failed", url: "https://ci.example/run" },
        { name: "Lint", status: "success", description: null, url: null },
        { name: "GitHub", status: "pending", description: null, url: null },
        { name: "Optional", status: "skipped", description: null, url: null },
      ]);
      expect(calls.some((request) => /comments|reviews\?/u.test(request.endpoint))).toBe(false);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          if (input.endpoint.includes("/reviewers?")) return { items: [], next: null };
          if (input.endpoint.includes("/labels?")) return { items: [] };
          if (input.endpoint.includes("/changes?")) {
            expect(input.endpoint).toContain("expectedVersion=1&limit=500");
            return { ...revision, items: [{ path: "src/a.ts", status: "modified" }], next: null };
          }
          if (input.endpoint.endsWith("/diff-files")) {
            expect(input.body).toEqual({ paths: ["src/a.ts"], expectedVersion: 1 });
            return { ...revision, items: [{ path: "src/a.ts", additions: 7, deletions: 2 }] };
          }
          if (input.endpoint.includes("/commits/")) {
            expect(input.endpoint).toBe("/repos/owner/repo/commits/abcdef/checks");
            return {
              items: [
                {
                  origin: "buildkite",
                  name: "CI",
                  status: "completed",
                  conclusion: "failure",
                  summary: "Failed",
                  detailsUrl: "https://ci.example/run",
                },
                {
                  origin: "gitcafe",
                  name: "Lint",
                  status: "completed",
                  conclusion: "success",
                  summary: null,
                  detailsUrl: null,
                },
                {
                  origin: "github",
                  name: "GitHub",
                  status: "queued",
                  conclusion: null,
                  summary: null,
                  detailsUrl: null,
                },
                {
                  origin: "github",
                  name: "Optional",
                  status: "completed",
                  conclusion: "skipped",
                  summary: null,
                  detailsUrl: null,
                },
              ],
            };
          }
          if (input.endpoint.endsWith("/status"))
            return {
              merge: { conflicts: "unknown", fastForward: false, strategies: ["merge"] },
              checks: { pending: 0, failing: 1, successful: 0, total: 1 },
            };
          return detail;
        }),
      ),
    );
  });
  it.effect("counts files but not lines past the line statistics cap", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getChangeRequest(target);
      expect(result.changedFiles).toBe(300);
      expect(result.additions).toBe(0);
      expect(calls.some((call) => call.endpoint.endsWith("/diff-files"))).toBe(false);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          if (input.endpoint.includes("/reviewers?")) return { items: [], next: null };
          if (input.endpoint.includes("/labels?")) return { items: [] };
          if (input.endpoint.includes("/changes?"))
            return {
              ...revision,
              items: Array.from({ length: 300 }, (_, index) => ({ path: `src/${index}.ts` })),
              next: null,
            };
          if (input.endpoint.includes("/commits/")) return { items: [] };
          if (input.endpoint.endsWith("/status"))
            return {
              merge: { conflicts: "unknown", fastForward: null, strategies: [] },
              checks: { pending: 0, failing: 0, successful: 0, total: 0 },
            };
          return detail;
        }),
      ),
    );
  });
  it.effect("loads detail labels from the dedicated bounded endpoint", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getChangeRequest(target);
      expect(result.labels).toEqual([{ name: "detail-label", color: "#123456" }]);
      expect(calls.filter((call) => call.endpoint.includes("/labels?"))).toEqual([
        expect.objectContaining({ endpoint: "/repos/owner/repo/pulls/7/labels?limit=100" }),
      ]);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          if (input.endpoint.includes("/reviewers?")) return { items: [], next: null };
          if (input.endpoint.includes("/labels?"))
            return { items: [{ name: "detail-label", color: "#123456" }] };
          if (input.endpoint.includes("/changes?")) return { ...revision, items: [], next: null };
          if (input.endpoint.includes("/commits/")) return { items: [] };
          if (input.endpoint.endsWith("/status"))
            return {
              merge: { conflicts: "unknown", fastForward: null, strategies: [] },
              checks: { pending: 0, failing: 0, successful: 0, total: 0 },
            };
          return { ...detail, labels: [{ name: "summary-label", color: "#ffffff" }] };
        }),
      ),
    );
  });
  it.effect("reads cursor comment and review envelopes and bounded commit items", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getChangeRequestActivity(target);
      expect(result.commits[0]?.oid).toBe("abcdef");
      expect(result.commentsTruncated).toBe(false);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          if (input.endpoint.includes("/commits?")) {
            expect(input.endpoint).toContain("limit=100");
            return {
              items: [{ oid: "abcdef", summary: "Change", time: 1789214400 }],
              truncated: false,
              next: null,
              headOid: "abcdef",
            };
          }
          if (input.endpoint.includes("/comments?") || input.endpoint.includes("/reviews?"))
            return { items: [], next: null };
          return detail;
        }),
      ),
    ),
  );
  it.effect("keeps unobserved historical PRs readable without resolving deleted branches", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const activity = yield* provider.getChangeRequestActivity(target);
      expect(activity.commits).toEqual([]);
      expect(calls.some((request) => request.endpoint.includes("/commits"))).toBe(false);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          return input.endpoint.includes("?")
            ? { items: [], next: null }
            : { ...detail, state: "closed", headOid: null };
        }),
      ),
    );
  });
  it.effect("pages reviews while keeping commits to one bounded page", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getChangeRequestActivity(target);
      expect(result.commits.map((commit) => commit.oid)).toEqual(["first"]);
      expect(result.commentsTruncated).toBe(false);
      expect(result.comments).toHaveLength(2);
      expect(calls.filter((call) => call.endpoint.includes("/commits?"))).toHaveLength(1);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          const query = new URL(input.endpoint, "https://git.cafe").searchParams;
          const second = query.has("after");
          if (input.endpoint.includes("/commits?"))
            return {
              items: [{ oid: second ? "second" : "first", summary: "Change", time: 1789214400 }],
              headOid: "abcdef",
              truncated: !second,
              next: second ? null : "first",
            };
          if (input.endpoint.includes("/reviews?"))
            return {
              items: [
                {
                  id: second ? "review2" : "review1",
                  author: actor,
                  body: null,
                  verdict: "approve",
                  dismissedAt: null,
                  createdAt: time,
                },
              ],
              next: second ? null : "review1",
            };
          if (input.endpoint.includes("/comments?")) return { items: [], next: null };
          return detail;
        }),
      ),
    );
  });
  it.effect("compares a fork commit against its first parent", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const first = yield* provider.getDiff({ ...target, commit: "selected" });
      expect(first.nextCursor).not.toBeNull();
      const second = yield* provider.getDiff({
        ...target,
        commit: "selected",
        cursor: first.nextCursor!,
      });
      expect(second.nextCursor).toBeNull();
      const compare = new URL(calls[2]!.endpoint, "https://git.cafe");
      expect(compare.pathname).toBe("/repos/fork/project/compare");
      expect(compare.searchParams.get("baseOid")).toBe("parent1");
      expect(compare.searchParams.get("headOid")).toBe("selected");
      expect(first.patch).toContain("@@ -1,1 +1,1 @@\n-old\n+new");
      const files = calls.find((call) => call.endpoint.endsWith("/compare/files"));
      expect(files?.endpoint).toBe("/repos/fork/project/compare/files");
      expect(files?.body).toEqual({
        base: "HEAD",
        baseOid: "parent1",
        head: "HEAD",
        headOid: "selected",
        paths: ["src/a.ts"],
      });
      const continued = new URL(
        calls.filter((call) => call.endpoint.includes("/compare?")).at(-1)!.endpoint,
        "https://git.cafe",
      );
      expect(continued.searchParams.get("after")).toBe("src/a.ts");
      expect(continued.searchParams.get("baseOid")).toBe("parent1");
      expect(continued.searchParams.get("headOid")).toBe("selected");
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          if (input.endpoint.includes("/commit?"))
            return { oid: "selected", parents: ["parent1", "parent2"] };
          if (input.endpoint.endsWith("/compare/files"))
            return { items: [{ path: "src/a.ts", status: "modified", hunks: [hunk] }] };
          if (input.endpoint.includes("/compare?")) {
            const continued = new URL(input.endpoint, "https://git.cafe").searchParams.has("after");
            return {
              base: "parent1",
              head: "selected",
              items: continued ? [] : [{ path: "src/a.ts", status: "modified" }],
              next: continued ? null : "src/a.ts",
            };
          }
          return { ...detail, sourceRepo: { owner: "fork", name: "project" } };
        }),
      ),
    );
  });
  it.effect.each([false, true])(
    "reads activity with read-only reactions (reaction request fails: %s)",
    (fails) =>
      Effect.gen(function* () {
        const provider = yield* make;
        const activity = yield* provider.getChangeRequestActivity(target);
        expect(activity.comments).toEqual([]);
        expect(activity.reactions).toEqual(
          fails
            ? undefined
            : [{ content: "thumbs-up", count: 3, actors: [], viewerHasReacted: true }],
        );
        expect(provider.capabilities.reactions).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mock(GitCafeCli.GitCafeCli)({
            api: (input) => {
              if (input.endpoint.endsWith("/reactions")) {
                if (fails)
                  return Effect.fail(
                    new GitCafeCli.GitCafeCliError({
                      command: "cafe",
                      cwd: target.cwd,
                      code: "UNAVAILABLE",
                      detail: "unavailable",
                      status: 503,
                    }),
                  );
                return Effect.succeed(
                  json({
                    items: [
                      {
                        subject: { kind: "pull_request", id: "pr_one" },
                        emoji: { kind: "unicode", value: "👍" },
                        count: 3,
                        viewerReactionId: "mine",
                        reactors: [],
                      },
                    ],
                  }),
                );
              }
              if (input.endpoint.includes("/comments?") || input.endpoint.includes("/reviews?"))
                return Effect.succeed(json({ items: [], next: null }));
              return Effect.succeed(json({ ...detail, headOid: null }));
            },
          }),
        ),
      ),
  );

  it.effect("reports root commits without fabricating an empty diff", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getDiff({ ...target, commit: "root" }).pipe(Effect.flip);
      expect(result.detail).toContain("root commit");
    }).pipe(
      Effect.provide(
        withApi((input) =>
          input.endpoint.includes("/commit?") ? { oid: "root", parents: [] } : detail,
        ),
      ),
    ),
  );
  it.effect("uses the rendered comparison base for review anchors", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getDiff(target);
      expect(result.truncated).toBe(true);
      expect(result.reviewRevision).toEqual({
        version: 1,
        headOid: "renderedhead",
        baseOid: "mergebase",
      });
      expect(result.nextCursor).toBeNull();
      expect(result.omittedFileStats).toEqual([{ path: "large.ts", additions: 0, deletions: 0 }]);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          // Too large for hunks, so it is listed without asking `/diff-files` for it.
          expect(input.endpoint).not.toContain("/diff-files");
          if (!input.endpoint.includes("/changes?")) return detail;
          expect(input.endpoint).toContain("expectedVersion=1&limit=64");
          return {
            items: [
              {
                path: "large.ts",
                oldPath: null,
                status: "modified",
                binary: false,
                tooLarge: true,
              },
            ],
            version: 1,
            headOid: "renderedhead",
            comparisonBaseOid: "mergebase",
            next: null,
          };
        }),
      ),
    ),
  );
  it.effect("continues diff pages at the pinned revision and ends", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const first = yield* provider.getDiff(target);
      expect(first.nextCursor).not.toBeNull();
      expect(first.reviewRevision).toEqual({
        version: 4,
        headOid: "abcdef",
        baseOid: "baseabcdef",
      });
      expect(first.patch).toContain("a/src/a.ts b/src/a.ts");
      expect(first.patch).toContain("@@ -1,1 +1,1 @@\n-old\n+new");
      const second = yield* provider.getDiff({ ...target, cursor: first.nextCursor! });
      expect(second.nextCursor).toBeNull();
      expect(second.patch).toContain("a/src/b.ts b/src/b.ts");
      expect(second.patch).not.toContain("src/a.ts");
      const pages = calls.filter((call) => call.endpoint.includes("/changes?"));
      const query = new URL(pages.at(-1)!.endpoint, "https://git.cafe").searchParams;
      expect(query.get("expectedVersion")).toBe("4");
      expect(query.get("after")).toBe("src/a.ts");
      expect(calls.filter((call) => call.endpoint === "/repos/owner/repo/pulls/7").length).toBe(1);
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          if (input.endpoint.endsWith("/diff-files")) {
            const [path] = (input.body as { paths: Array<string> }).paths;
            return {
              ...revision,
              version: 4,
              items: [{ path, status: "modified", hunks: [hunk] }],
            };
          }
          if (!input.endpoint.includes("/changes?")) return { ...detail, version: 4 };
          const continued = new URL(input.endpoint, "https://git.cafe").searchParams.has("after");
          return {
            ...revision,
            items: [{ path: continued ? "src/b.ts" : "src/a.ts", status: "modified" }],
            version: 4,
            next: continued ? null : "src/a.ts",
          };
        }),
      ),
    );
  });
  it.effect("rejects a diff page whose returned revision differs from the requested revision", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getDiff(target).pipe(Effect.flip);
      expect(result.detail).toContain("different diff snapshot");
      expect(result.detail).toContain("revision 1");
    }).pipe(
      Effect.provide(
        withApi((input) =>
          input.endpoint.includes("/changes?")
            ? { ...revision, items: [], version: 5, next: null }
            : detail,
        ),
      ),
    ),
  );
  it.effect("rejects a continued diff page when the head changes at the same version", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const first = yield* provider.getDiff(target);
      const result = yield* provider
        .getDiff({ ...target, cursor: first.nextCursor! })
        .pipe(Effect.flip);
      expect(result.detail).toContain("different diff snapshot");
    }).pipe(
      Effect.provide(
        withApi((input) => {
          if (!input.endpoint.includes("/changes?")) return detail;
          const continued = new URL(input.endpoint, "https://git.cafe").searchParams.has("after");
          return {
            items: [],
            version: 1,
            headOid: continued ? "advanced-head" : "reviewed-head",
            comparisonBaseOid: "reviewed-base",
            next: continued ? null : "src/a.ts",
          };
        }),
      ),
    ),
  );
  it.effect("rejects malformed diff cursors before calling GitCafe", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getDiff({ ...target, cursor: "not-json" }).pipe(Effect.flip);
      expect(result.detail).toContain("Invalid GitCafe diff cursor");
      expect(calls).toHaveLength(0);
    }).pipe(Effect.provide(withApi((input) => (calls.push(input), detail))));
  });
  it.effect.each([
    ["change", "before", "after", ["before", "after"]],
    ["new", null, "created", ["", "created"]],
    ["deleted", "removed", null, ["removed", ""]],
    ["rename-changed", "old name", "new name", ["old name", "new name"]],
  ] as const)(
    "expands %s files from the pull snapshot",
    ([changeType, oldContent, newContent, expected]) =>
      Effect.gen(function* () {
        const provider = yield* make;
        const result = yield* provider.getDiffFileContents!({
          ...target,
          changeType,
          oldPath: "old name.ts",
          newPath: "new name.ts",
        });
        expect([result.oldContents, result.newContents]).toEqual(expected);
      }).pipe(
        Effect.provide(
          withApi((input) => {
            if (!input.endpoint.includes("/diff-file?")) return { ...detail, version: 9 };
            const query = new URL(input.endpoint, "https://git.cafe").searchParams;
            expect(query.get("expectedVersion")).toBe("9");
            expect(query.get("path")).toBe(
              changeType === "deleted" ? "old name.ts" : "new name.ts",
            );
            return { version: 9, file: { oldContent, newContent } };
          }),
        ),
      ),
  );

  it.effect("expands an old displayed revision without substituting the latest pull", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getDiffFileContents!({
        ...target,
        changeType: "change",
        oldPath: "old.ts",
        newPath: "new.ts",
        reviewRevision: { version: 3, headOid: "displayed-head", baseOid: "displayed-base" },
      });
      expect(result).toEqual({ oldContents: "old snapshot", newContents: "new snapshot" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.endpoint).toContain("expectedVersion=3");
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          if (!input.endpoint.includes("/diff-file?")) return { ...detail, version: 9 };
          expect(input.endpoint).toContain("expectedVersion=3");
          return {
            version: 3,
            headOid: "displayed-head",
            comparisonBaseOid: "displayed-base",
            file: { oldContent: "old snapshot", newContent: "new snapshot" },
          };
        }),
      ),
    );
  });
  it.effect.each([
    ["version", { version: 4, headOid: "displayed-head", comparisonBaseOid: "displayed-base" }],
    ["head", { version: 3, headOid: "other-head", comparisonBaseOid: "displayed-base" }],
    ["base", { version: 3, headOid: "displayed-head", comparisonBaseOid: "other-base" }],
  ] as const)("rejects diff-file contents with a mismatched response %s", ([mismatch, response]) =>
    Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getDiffFileContents!({
        ...target,
        changeType: "change",
        oldPath: "file.ts",
        newPath: "file.ts",
        reviewRevision: { version: 3, headOid: "displayed-head", baseOid: "displayed-base" },
      }).pipe(Effect.flip);
      expect(result.detail).toContain("different diff snapshot");
    }).pipe(
      Effect.provide(
        withApi(() => ({
          ...response,
          file: { oldContent: "old", newContent: "new" },
        })),
      ),
    ),
  );

  it.effect("reports unavailable full-file content", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getDiffFileContents!({
        ...target,
        changeType: "change",
        oldPath: "large.ts",
        newPath: "large.ts",
      }).pipe(Effect.flip);
      expect(result.detail).toContain("too_large");
    }).pipe(
      Effect.provide(
        withApi((input) =>
          input.endpoint.includes("/diff-file?")
            ? {
                version: 1,
                file: {
                  oldContent: null,
                  newContent: "after",
                  oldContentUnavailableReason: "too_large",
                },
              }
            : detail,
        ),
      ),
    ),
  );
  it.effect("expands fork commit renames using exact parent and commit OIDs", () => {
    const calls: Request[] = [];
    return Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getDiffFileContents!({
        ...target,
        commit: "headoid",
        changeType: "rename-changed",
        oldPath: "old.ts",
        newPath: "new.ts",
      });
      expect(result).toEqual({ oldContents: "parent file", newContents: "head file" });
      const blobs = calls.filter((call) => call.endpoint.includes("/blob?"));
      expect(blobs.every((call) => call.endpoint.startsWith("/repos/fork/project/blob?"))).toBe(
        true,
      );
      expect(
        blobs.map((call) => new URL(call.endpoint, "https://git.cafe").searchParams.get("oid")),
      ).toEqual(expect.arrayContaining(["parentoid", "headoid"]));
    }).pipe(
      Effect.provide(
        withApi((input) => {
          calls.push(input);
          if (input.endpoint.includes("/commit?"))
            return { oid: "headoid", parents: ["parentoid"] };
          if (input.endpoint.includes("/blob?")) {
            const oid = new URL(input.endpoint, "https://git.cafe").searchParams.get("oid");
            return { binary: false, content: oid === "parentoid" ? "parent file" : "head file" };
          }
          return { ...detail, sourceRepo: { owner: "fork", name: "project" } };
        }),
      ),
    );
  });
  it.effect("reports absent native stacks directly", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      expect(yield* provider.getChangeRequestStack!(target)).toBeNull();
    }).pipe(Effect.provide(withApi(() => ({ stack: null })))),
  );
  it.effect("returns stack members without inventing unavailable heads", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const stack = yield* provider.getChangeRequestStack!(target);
      expect(stack).toMatchObject({
        revision: 3,
        layers: [{ number: 7 }],
      });
      expect(stack?.layers[0]).not.toHaveProperty("headSha");
    }).pipe(
      Effect.provide(
        withApi((input) => {
          expect(input.endpoint).toBe("/repos/owner/repo/pulls/7/stack");
          return {
            stack: {
              id: "stack",
              number: 2,
              revision: 3,
              landingBase: "main",
              members: [
                {
                  pullRequestNumber: 7,
                  title: "Change",
                  state: "open",
                  draft: false,
                  sourceBranch: "feature",
                  position: 1,
                },
              ],
            },
          };
        }),
      ),
    ),
  );
  it.effect("enables mapped write capabilities", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      expect(provider.capabilities).toMatchObject({
        comment: true,
        actions: ["ready", "draft", "close", "reopen", "merge", "update-branch"],
        stackActions: true,
        reactions: true,
        labels: true,
        edit: { changeRequest: true, comment: true },
      });
    }).pipe(Effect.provide(withApi(() => detail))),
  );
  it.effect("preserves rate-limit failures instead of substituting empty reads", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const result = yield* provider.getChangeRequestStack!(target).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "rate-limited" } });
    }).pipe(
      Effect.provide(
        Layer.mock(GitCafeCli.GitCafeCli)({
          api: () =>
            Effect.fail(
              new GitCafeCli.GitCafeCliError({
                command: "cafe",
                cwd: target.cwd,
                code: "RATE_LIMITED",
                status: 429,
                detail: "Limited",
              }),
            ),
        }),
      ),
    ),
  );
});
