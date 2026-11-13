import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import { argsOfCall, author, callAt, diffPage, layer, mergeRequestJson, mergeRequests, mockedExecute, notes, output, reviewer } from "./GitLabPullRequestCli.helpers2.testkit.ts";

afterEach(() => {
  mockedExecute.mockReset();
});

layer("GitLabPullRequestCli.layer", (it) => {

  it.effect("reads the project's merge settings as its merge capabilities", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ merge_method: "ff", squash_option: "never" }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const capabilities = yield* cli.getProjectMergeCapabilities({
        cwd: "/w",
        repository: "acme/web",
      });

      assert.deepStrictEqual(capabilities, { merge: false, squash: false, rebase: true });
    }),
  );

  it.effect("fails when the authenticated account has no username", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(JSON.stringify({ username: "" }))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(cli.getViewerUsername({ cwd: "/w" }));

      assert.strictEqual(error._tag, "GitLabViewerUnavailableError");
    }),
  );

  it.effect("walks the notes until GitLab answers with a short page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(notes(100, 1))));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(notes(2, 101))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { comments, truncated } = yield* cli.listNotes({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(argsOfCall(0).join(" ")).toContain("page=1");
      expect(argsOfCall(1).join(" ")).toContain("page=2");
      assert.strictEqual(comments.length, 102);
      assert.isFalse(truncated);
    }),
  );

  it.effect("stops the note walk at its bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(notes(100, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { truncated } = yield* cli.listNotes({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 10);
      assert.isTrue(truncated);
    }),
  );

  it.effect("reads a positioned discussion as a thread anchored to its line", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify([
              {
                id: "abc123",
                notes: [
                  {
                    id: 1,
                    body: "rename this",
                    author: { username: "bilal", avatar_url: "https://avatars/b.png" },
                    created_at: "2026-07-01T00:00:00Z",
                    resolvable: true,
                    resolved: true,
                    position: {
                      position_type: "text",
                      new_path: "src/a.ts",
                      old_path: "src/a.ts",
                      new_line: 12,
                      old_line: null,
                    },
                  },
                  {
                    id: 2,
                    body: "done",
                    author: { username: "julius" },
                    created_at: "2026-07-01T01:00:00Z",
                  },
                ],
              },
              { id: "def456", notes: [{ id: 3, body: "ship it", created_at: "2026-07-01Z" }] },
            ]),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { threads } = yield* cli.listDiscussions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(threads.length, 1);
      expect(threads[0]).toMatchObject({
        id: "abc123",
        path: "src/a.ts",
        line: 12,
        side: "right",
        isResolved: true,
      });
      assert.strictEqual(threads[0]?.comments.length, 2);
    }),
  );

  it.effect("sends a review as its comments, then its summary, then the verdict", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [
          {
            path: "src/b.ts",
            oldPath: "src/a.ts",
            position: { kind: "deleted", oldLine: 4 },
            body: "why remove?",
          },
        ],
      });

      expect(argsOfCall(0)[1]).toContain("merge_requests/7");
      expect(argsOfCall(1)[1]).toContain("/discussions");
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({
        body: "why remove?",
        position: {
          base_sha: "base",
          head_sha: "head",
          start_sha: "start",
          position_type: "text",
          old_path: "src/a.ts",
          new_path: "src/b.ts",
          old_line: 4,
        },
      });
      expect(argsOfCall(2)[1]).toContain("/notes");
      expect(argsOfCall(3)[1]).toContain("/approve");
    }),
  );

  it.effect("removes an award by listing them and deleting the reader's own id", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ username: "bilal" }))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify([
              { id: 5, name: "thumbsup", user: { username: "bilal" } },
              { id: 6, name: "thumbsup", user: { username: "julius" } },
            ]),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        content: "thumbs-up",
        reacted: false,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect(argsOfCall(2)).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7/award_emoji/5",
        "--method",
        "DELETE",
      ]);
    }),
  );

  it.effect("names a merge request with no diff revisions rather than calling it unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: null,
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.submitReview({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          verdict: "comment",
          body: "",
          comments: [{ path: "src/a.ts", position: { kind: "added", newLine: 4 }, body: "nit" }],
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffRefsUnavailableError");
    }),
  );

  it.effect("shows a failed child pipeline that left the head pipeline green", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              mergeRequestJson({
                // A fork's pipeline runs in the source project, so its id is not the target's.
                head_pipeline: {
                  id: 31,
                  project_id: 12,
                  status: "success",
                  web_url: "https://gitlab.com/bilal/web/-/pipelines/31",
                },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify([
                {
                  name: "deploy",
                  status: "success",
                  downstream_pipeline: {
                    status: "failed",
                    web_url: "https://gitlab.com/bilal/web/-/pipelines/32",
                  },
                },
                { name: "docs", status: "created", downstream_pipeline: null },
              ]),
            ),
          ),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(detail.checks.map((check) => [check.name, check.status, check.url])).toEqual([
        ["Pipeline", "success", "https://gitlab.com/bilal/web/-/pipelines/31"],
        ["deploy", "failure", "https://gitlab.com/bilal/web/-/pipelines/32"],
      ]);
      expect(argsOfCall(1)[1]).toBe("projects/12/pipelines/31/bridges?per_page=100");
    }),
  );

  it.effect("keeps the one pipeline check when the trigger jobs cannot be read whole", () =>
    Effect.gen(function* () {
      const detailOutput = output(
        mergeRequestJson({ head_pipeline: { id: 31, project_id: 12, status: "success" } }),
      );
      const failedChild = { name: "deploy", downstream_pipeline: { status: "failed" } };
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(detailOutput))
        .mockReturnValueOnce(
          Effect.fail(
            new GitLabCli.GitLabCliCommandError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: new Error("403 Forbidden"),
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(detailOutput))
        // A full page may have left out the trigger job whose pipeline failed.
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify(Array.from({ length: 100 }, () => failedChild)))),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      for (const scenario of ["read fails", "page is full"]) {
        const detail = yield* cli.getMergeRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
        });
        expect(
          detail.checks.map((check) => [check.name, check.status]),
          scenario,
        ).toEqual([["Pipeline", "success"]]);
      }
    }),
  );

  it.effect("reads merge permissions without reading the trigger jobs", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            mergeRequestJson({
              head_pipeline: { id: 31, project_id: 12, status: "success" },
              user: { can_merge: false },
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        downstreamChecks: false,
      });

      expect(detail.viewerCanMerge).toBe(false);
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("reads who has access to the project and who is already on the merge request", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify([author, reviewer, { id: 9, username: "hubot" }]))),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(argsOfCall(1)[1]).toBe("projects/acme%2Fweb/users?per_page=100");
      expect(list.candidates.map((candidate) => [candidate.id, candidate.isRequested])).toEqual([
        ["5", true],
        ["9", false],
      ]);
      assert.isFalse(list.truncated);
    }),
  );

  it.effect("writes the reviewer set back with the one being asked added to it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: true,
      });

      expect(argsOfCall(1)).toContain("PUT");
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5, 9] });
    }),
  );

  it.effect("takes a reviewer out of the set rather than clearing it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(mergeRequestJson({ reviewers: [reviewer, { id: 9, username: "hubot" }] })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: false,
      });

      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5] });
    }),
  );

  it.effect("ignores an id GitLab could not have handed out, which names nobody", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "octocat" }],
        requested: true,
      });

      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5] });
    }),
  );
  it.effect("reads blob ids for the marked paths at the merge request's head", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: {
                project: { repository: { blobs: { nodes: [{ path: "src/a.ts", oid: "aaa" }] } } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths: ["src/a.ts", "src/gone.ts"],
      });

      expect([...revisions]).toEqual([
        ["src/a.ts", "aaa"],
        ["src/gone.ts", ""],
      ]);
      const body: unknown = JSON.parse(callAt(1).stdin ?? "{}");
      expect(body).toMatchObject({
        variables: { fullPath: "acme/web", ref: "head", paths: ["src/a.ts", "src/gone.ts"] },
      });
    }),
  );

  it.effect("leaves the paths out when GitLab did not answer the blobs query", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ data: { project: null } }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths: ["src/a.ts", "src/b.ts"],
      });

      expect([...revisions]).toEqual([]);
    }),
  );

  it.effect("splits the paths across requests, because GitLab charges the query by how many", () =>
    Effect.gen(function* () {
      const paths = Array.from({ length: 150 }, (_, index) => `src/${index}.ts`);
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockImplementation((request) => {
        const body = JSON.parse(request.stdin ?? "{}") as {
          readonly variables: { readonly paths: ReadonlyArray<string> };
        };
        return Effect.succeed(
          output(
            JSON.stringify({
              data: {
                project: {
                  repository: {
                    blobs: {
                      nodes: body.variables.paths.map((path) => ({ path, oid: `oid-${path}` })),
                    },
                  },
                },
              },
            }),
          ),
        );
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths,
      });

      assert.strictEqual(revisions.size, 150);
      assert.strictEqual(revisions.get("src/149.ts"), "oid-src/149.ts");
      assert.strictEqual(mockedExecute.mock.calls.length, 3);
    }),
  );

  it.effect(
    "reads line counts a hundred at a time per project, keeping the reads that answered",
    () =>
      Effect.gen(function* () {
        const variablesOf = (stdin: string | undefined) =>
          (
            JSON.parse(stdin ?? "{}") as {
              readonly variables: {
                readonly fullPath: string;
                readonly iids: ReadonlyArray<string>;
              };
            }
          ).variables;
        mockedExecute.mockImplementation((request) => {
          const { fullPath, iids } = variablesOf(request.stdin);
          // GitLab answers only what it has (iid 3 is missing), and one project's read fails.
          const nodes = iids
            .filter((iid) => iid !== "3")
            .map((iid) => ({ iid, diffStatsSummary: { additions: Number(iid), deletions: 1 } }));
          return Effect.succeed(
            output(
              JSON.stringify(
                fullPath === "acme/api"
                  ? { errors: [{ message: "Query timed out" }] }
                  : { data: { project: { mergeRequests: { nodes } } } },
              ),
            ),
          );
        });
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const stats = yield* cli.listMergeRequestStats({
          cwd: "/w",
          changeRequests: [
            ...Array.from({ length: 150 }, (_, index) => ({
              repository: "acme/web",
              number: index + 1,
            })),
            { repository: "acme/api", number: 9 },
          ],
        });

        expect(stats).toHaveLength(149);
        expect(stats).toContainEqual({
          repository: "acme/web",
          number: 150,
          additions: 150,
          deletions: 1,
        });
        expect(stats.some((stat) => stat.number === 3 || stat.repository === "acme/api")).toBe(
          false,
        );
        expect(
          mockedExecute.mock.calls.map(([request]) => {
            const { fullPath, iids } = variablesOf(request.stdin);
            return [fullPath, iids.length];
          }),
        ).toEqual([
          ["acme/web", 100],
          ["acme/web", 50],
          ["acme/api", 1],
        ]);
      }),
  );
  it.effect.each([
    GitLabCli.GitLabCliUnavailableError,
    GitLabCli.GitLabCliAuthenticationError,
    GitLabCli.GitLabCliRateLimitError,
  ])("propagates unusable CLI and account failures from stats (%s)", (ErrorType) =>
    Effect.gen(function* () {
      const error = new ErrorType({
        operation: "execute",
        command: "glab",
        cwd: "/w",
        cause: null,
      });
      mockedExecute.mockReturnValueOnce(Effect.fail(error));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const result = yield* Effect.result(
        cli.listMergeRequestStats({
          cwd: "/w",
          changeRequests: [{ repository: "acme/web", number: 7 }],
        }),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: error });
    }),
  );
});
