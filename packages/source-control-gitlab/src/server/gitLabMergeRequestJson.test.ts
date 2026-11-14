import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeAwardEmojiJson,
  decodeRepositoryBlobsJson,
  decodeCommitsJson,
  decodeGraphqlListSupportJson,
  decodeMergeRequestGraphqlListJson,
  decodeMergeMessagesJson,
  decodeMergeRequestDetailJson,
  decodeMergeRequestDiffsJson,
  decodeMergeRequestListJson,
  decodeMergeRequestFileStatsJson,
  decodeMergeRequestStatsJson,
  decodeReferenceCandidatesJson,
  decodeNotesJson,
  decodeOwnAwardIdJson,
  decodeListStatesJson,
  decodeTriggerJobChecksJson,
  decodePipelineStageChecksJson,
} from "./gitLabMergeRequestJson.ts";

function listJson(entries: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify(
    entries.map((entry) => ({
      iid: 1,
      title: "Add the merge requests page",
      web_url: "https://gitlab.com/acme/web/-/merge_requests/1",
      source_branch: "feat/page",
      target_branch: "main",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
      ...entry,
    })),
  );
}

function detailJson(entry: Record<string, unknown>): string {
  return JSON.stringify({
    iid: 1,
    title: "Add the merge requests page",
    web_url: "https://gitlab.com/acme/web/-/merge_requests/1",
    source_branch: "feat/page",
    target_branch: "main",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    ...entry,
  });
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("decodeMergeRequestListJson", () => {
  it("reads a merge request as a change request", () => {
    const batch = expectSuccess(
      decodeMergeRequestListJson(
        listJson([
          {
            iid: 42,
            author: { username: "bilal", name: "Bilal" },
            state: "opened",
            merge_status: "can_be_merged",
            draft: false,
            reviewers: [{ username: "julius" }],
            labels: ["backend", "  "],
          },
        ]),
      ),
    );

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      number: 42,
      author: { login: "bilal", name: "Bilal" },
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      reviewRequestLogins: ["julius"],
      labels: [{ name: "backend", color: null }],
    });
  });

  it("treats a merged timestamp as merged whatever the state says", () => {
    const batch = expectSuccess(
      decodeMergeRequestListJson(
        listJson([{ state: "opened", merged_at: "2026-07-03T00:00:00Z" }]),
      ),
    );

    expect(batch.items[0]?.state).toBe("merged");
  });

  it("reads the legacy draft flag", () => {
    const batch = expectSuccess(decodeMergeRequestListJson(listJson([{ work_in_progress: true }])));

    expect(batch.items[0]?.isDraft).toBe(true);
  });

  it("calls a conflicted merge request conflicting even while the merge check is pending", () => {
    const batch = expectSuccess(
      decodeMergeRequestListJson(listJson([{ merge_status: "checking", has_conflicts: true }])),
    );

    expect(batch.items[0]?.mergeability).toBe("conflicting");
  });

  it("skips a malformed row but still counts it, so paging does not stop early", () => {
    const batch = expectSuccess(
      decodeMergeRequestListJson(
        JSON.stringify([{ iid: "not a number" }, ...JSON.parse(listJson([{}]))]),
      ),
    );

    expect(batch.items).toHaveLength(1);
    expect(batch.rawIndexes).toEqual([1]);
    expect(batch.rawCount).toBe(2);
  });
});

describe("decodeMergeRequestDetailJson", () => {
  it("reads the description, file count and pipeline", () => {
    const detail = expectSuccess(
      decodeMergeRequestDetailJson(
        detailJson({
          description: "Ships the page.",
          changes_count: "3",
          reviewers: [{ username: "julius", name: "Julius" }],
          head_pipeline: {
            status: "success",
            web_url: "https://gitlab.com/acme/web/-/pipelines/9",
            source: "merge_request_event",
          },
        }),
      ),
    );

    expect(detail.body).toBe("Ships the page.");
    expect(detail.changedFiles).toBe(3);
    expect(detail.reviewers).toEqual([{ login: "julius", name: "Julius", avatarUrl: null }]);
    expect(detail.checks).toEqual([
      {
        name: "Pipeline",
        status: "success",
        description: "merge_request_event",
        url: "https://gitlab.com/acme/web/-/pipelines/9",
      },
    ]);
  });

  it.each(["canceled", "canceling"])("maps a %s pipeline to cancelled", (status) => {
    const detail = expectSuccess(
      decodeMergeRequestDetailJson(detailJson({ head_pipeline: { status } })),
    );

    expect(detail.checks[0]?.status).toBe("cancelled");
  });

  it("reads an uncounted change set as its floor", () => {
    const detail = expectSuccess(
      decodeMergeRequestDetailJson(detailJson({ changes_count: "1000+" })),
    );

    expect(detail.changedFiles).toBe(1000);
  });

  it("reads the head commit, and says nothing where GitLab omitted it", () => {
    const headSha = (entry: Record<string, unknown>) =>
      expectSuccess(decodeMergeRequestDetailJson(detailJson(entry))).headSha;
    const sha = "afce4da4d5fe7d2fd0647b5b864526ea0a2827cb";

    expect(headSha({ sha })).toBe(sha);
    expect(headSha({ sha, diff_refs: null })).toBe(sha);
    expect(headSha({ sha, merge_commit_sha: "0".repeat(40) })).toBe(sha);
    expect(headSha({})).toBeUndefined();
    expect(headSha({ sha: null })).toBeUndefined();
    expect(headSha({ sha: "  " })).toBeUndefined();
  });

  it("reads the diff refs threads are placed against", () => {
    const diffRefs = (entry: Record<string, unknown>) =>
      expectSuccess(decodeMergeRequestDetailJson(detailJson(entry))).diffRefs;

    expect(diffRefs({ diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } })).toEqual({
      baseSha: "b",
      startSha: "s",
      headSha: "h",
    });
    expect(diffRefs({ diff_refs: null })).toBeUndefined();
    expect(
      diffRefs({ diff_refs: { base_sha: null, start_sha: "s", head_sha: "h" } }),
    ).toBeUndefined();
  });

  it("reads either auto-merge field, and says nothing where GitLab named neither", () => {
    const armed = (entry: Record<string, unknown>) =>
      expectSuccess(decodeMergeRequestDetailJson(detailJson(entry))).autoMergeEnabled;

    expect(armed({ merge_when_pipeline_succeeds: true })).toBe(true);
    expect(armed({ auto_merge_enabled: true })).toBe(true);
    expect(armed({ merge_when_pipeline_succeeds: false })).toBe(false);
    expect(armed({})).toBeUndefined();
  });

  it("keeps the squash choice stored with auto-merge", () => {
    expect(
      expectSuccess(
        decodeMergeRequestDetailJson(
          detailJson({ auto_merge_enabled: true, squash_on_merge: true }),
        ),
      ),
    ).toMatchObject({ autoMergeEnabled: true, autoMergeMethod: "squash" });

    expect(
      expectSuccess(
        decodeMergeRequestDetailJson(
          detailJson({
            auto_merge_enabled: true,
            squash: true,
            squash_on_merge: false,
          }),
        ),
      ).autoMergeMethod,
    ).toBeUndefined();
  });

  it("keeps a divergence GitLab did not count apart from a divergence of none", () => {
    const behind = (entry: Record<string, unknown>) =>
      expectSuccess(decodeMergeRequestDetailJson(detailJson(entry))).divergedCommits;

    expect(behind({ diverged_commits_count: 3 })).toBe(3);
    expect(behind({ diverged_commits_count: 0 })).toBe(0);
    expect(behind({})).toBeUndefined();
    expect(behind({ diverged_commits_count: null })).toBeUndefined();
  });

  it.each(["scheduled", " SCHEDULED "])("keeps a delayed pipeline pending: %s", (status) => {
    const detail = expectSuccess(
      decodeMergeRequestDetailJson(detailJson({ head_pipeline: { status } })),
    );

    expect(detail.checks[0]?.status).toBe("pending");
  });

  it("maps a pipeline waiting on a person to neutral, not failure", () => {
    const detail = expectSuccess(
      decodeMergeRequestDetailJson(detailJson({ head_pipeline: { status: "manual" } })),
    );

    expect(detail.checks[0]?.status).toBe("neutral");
  });
});

describe("decodePipelineStageChecksJson", () => {
  function stagesJson(
    stages: ReadonlyArray<Record<string, unknown> | null> | null,
    hasNextPage = false,
  ): string {
    return JSON.stringify({
      data: {
        project: {
          mergeRequest: {
            headPipeline:
              stages === null
                ? null
                : {
                    path: "/fork/web/-/pipelines/9",
                    stages: { nodes: stages, pageInfo: { hasNextPage } },
                  },
          },
        },
      },
    });
  }

  it("shows every job under its stage", () => {
    const checks = expectSuccess(
      decodePipelineStageChecksJson(
        stagesJson([
          {
            name: "build",
            status: "success",
            jobs: {
              nodes: [
                { name: "compile", status: "FAILED", retried: true, webPath: "/acme/web/-/jobs/1" },
                {
                  name: "compile",
                  status: "SUCCESS",
                  detailedStatus: { label: "passed" },
                  webPath: "/acme/web/-/jobs/2",
                },
              ],
            },
          },
          {
            name: "test",
            status: "failed",
            jobs: {
              nodes: [
                {
                  name: "unit",
                  status: "FAILED",
                  allowFailure: false,
                  webPath: "/acme/web/-/jobs/3",
                },
                {
                  name: "lint",
                  status: "FAILED",
                  allowFailure: true,
                  webPath: "/acme/web/-/jobs/4",
                },
                { name: "slow", status: "CANCELED", webPath: "/acme/web/-/jobs/5" },
                { name: "e2e", status: "RUNNING", webPath: "/acme/web/-/jobs/6" },
              ],
            },
          },
          {
            name: "deploy",
            status: "manual",
            jobs: { nodes: [{ name: "release", status: "MANUAL", webPath: "/acme/web/-/jobs/7" }] },
          },
        ]),
        "https://gitlab.example.com",
      ),
    );

    expect(checks?.map((check) => [check.name, check.status, check.url])).toEqual([
      ["build / compile", "success", "https://gitlab.example.com/acme/web/-/jobs/2"],
      ["test / unit", "failure", "https://gitlab.example.com/acme/web/-/jobs/3"],
      ["test / lint", "neutral", "https://gitlab.example.com/acme/web/-/jobs/4"],
      ["test / slow", "cancelled", "https://gitlab.example.com/acme/web/-/jobs/5"],
      ["test / e2e", "pending", "https://gitlab.example.com/acme/web/-/jobs/6"],
      ["deploy / release", "neutral", "https://gitlab.example.com/acme/web/-/jobs/7"],
    ]);
    expect(checks?.[0]?.description).toBe("passed");
  });

  it.each([
    ["no jobs", undefined],
    ["an empty job list", { nodes: [] }],
    [
      "more jobs than one page",
      { nodes: [{ name: "unit", status: "FAILED" }], pageInfo: { hasNextPage: true } },
    ],
    ["a job GitLab could not resolve", { nodes: [{ name: "unit", status: "FAILED" }, null] }],
    [
      "a job without a name",
      {
        nodes: [
          { name: "unit", status: "FAILED" },
          { name: null, status: "FAILED" },
        ],
      },
    ],
  ])("keeps a stage whole where its jobs come back with %s", (_, jobs) => {
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          stagesJson([
            {
              name: "test",
              status: "failed",
              detailedStatus: { label: "failed", detailsPath: "/fork/web/-/pipelines/9#test" },
              ...(jobs === undefined ? {} : { jobs }),
            },
          ]),
          "https://gitlab.com",
        ),
      ),
    ).toEqual([
      {
        name: "test",
        status: "failure",
        description: "failed",
        url: "https://gitlab.com/fork/web/-/pipelines/9#test",
      },
    ]);
  });

  it("answers nothing where there are no stages to show", () => {
    expect(
      expectSuccess(decodePipelineStageChecksJson(stagesJson(null), "https://gitlab.com")),
    ).toBe(null);
    expect(expectSuccess(decodePipelineStageChecksJson(stagesJson([]), "https://gitlab.com"))).toBe(
      null,
    );
    // A stage past the first page could be the failed one.
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          stagesJson([{ name: "build", status: "success" }], true),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
    // A stage GitLab failed to resolve comes back null beside an error, and could be the failed one.
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          stagesJson([{ name: "build", status: "success" }, null]),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          stagesJson([
            { name: "build", status: "success" },
            { name: null, status: "failed" },
          ]),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          JSON.stringify({
            ...JSON.parse(stagesJson([{ name: "build", status: "success" }])),
            errors: [{ message: "boom" }],
          }),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
    // GitLab answers an error it hit with no data at all.
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          JSON.stringify({ errors: [{ message: "boom" }] }),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
  });
});

describe("decodeNotesJson", () => {
  it("keeps comments and drops GitLab's own activity notes", () => {
    const notes = expectSuccess(
      decodeNotesJson(
        JSON.stringify([
          {
            id: 1,
            body: "assigned to @bilal",
            system: true,
            created_at: "2026-07-01T00:00:00Z",
          },
          {
            id: 2,
            body: "Looks good.",
            author: { username: "julius" },
            created_at: "2026-07-02T00:00:00Z",
          },
          { id: 3, body: "   ", created_at: "2026-07-03T00:00:00Z" },
        ]),
      ),
    );

    expect(notes.comments).toHaveLength(1);
    expect(notes.comments[0]).toMatchObject({
      id: "2",
      kind: "issue-comment",
      body: "Looks good.",
    });
    expect(notes.rawCount).toBe(3);
  });

  it("reads a line note as a review comment on its file", () => {
    const notes = expectSuccess(
      decodeNotesJson(
        JSON.stringify([
          {
            id: 7,
            type: "DiffNote",
            body: "Rename this.",
            created_at: "2026-07-02T00:00:00Z",
            position: { new_path: "src/app.ts", old_path: "src/old.ts" },
          },
        ]),
      ),
    );

    expect(notes.comments[0]).toMatchObject({ kind: "review-comment", path: "src/app.ts" });
  });

  it("falls back to the old path for a note on a deleted line", () => {
    const notes = expectSuccess(
      decodeNotesJson(
        JSON.stringify([
          {
            id: 8,
            type: "DiffNote",
            body: "Gone.",
            created_at: "2026-07-02T00:00:00Z",
            position: { new_path: null, old_path: "src/old.ts" },
          },
        ]),
      ),
    );

    expect(notes.comments[0]?.path).toBe("src/old.ts");
  });
});

describe("decodeCommitsJson", () => {
  it("falls back to the creation timestamp when there is no commit date", () => {
    const commits = expectSuccess(
      decodeCommitsJson(
        JSON.stringify([
          {
            id: "aaa",
            created_at: "2026-07-01T00:00:00+08:00",
            author_name: "Ada Lovelace",
            author_email: "ada@example.com",
          },
        ]),
      ),
    );

    expect(commits[0]).toMatchObject({
      oid: "aaa",
      committedDate: "2026-07-01T00:00:00+08:00",
      authors: [{ login: "Ada Lovelace", name: "Ada Lovelace", avatarUrl: null }],
    });
  });
});

describe("decodeMergeRequestDiffsJson", () => {
  it("quotes literal backslashes without interpreting them as escapes", () => {
    const result = expectSuccess(
      decodeMergeRequestDiffsJson(
        JSON.stringify([
          {
            old_path: String.raw`src\notes.ts`,
            new_path: String.raw`src\notes.ts`,
            diff: "@@ -1 +1 @@\n-old\n+new",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        String.raw`diff --git "a/src\\notes.ts" "b/src\\notes.ts"`,
        String.raw`--- "a/src\\notes.ts"`,
        String.raw`+++ "b/src\\notes.ts"`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
  });

  it("preserves spaces and literal backslashes in both rename paths", () => {
    const result = expectSuccess(
      decodeMergeRequestDiffsJson(
        JSON.stringify([
          {
            old_path: String.raw` old\name.ts `,
            new_path: String.raw` new\name.ts `,
            renamed_file: true,
            diff: "",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        String.raw`diff --git "a/ old\\name.ts " "b/ new\\name.ts "`,
        "similarity index 100%",
        String.raw`rename from " old\\name.ts "`,
        String.raw`rename to " new\\name.ts "`,
        String.raw`--- "a/ old\\name.ts "`,
        String.raw`+++ "b/ new\\name.ts "`,
      ].join("\n"),
    );
  });

  it("assembles a unified patch GitLab does not return", () => {
    const result = expectSuccess(
      decodeMergeRequestDiffsJson(
        JSON.stringify([
          {
            old_path: "src/app.ts",
            new_path: "src/app.ts",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
    expect(result.truncated).toBe(false);
  });

  it("points a new file at /dev/null on the left and a deleted file on the right", () => {
    const result = expectSuccess(
      decodeMergeRequestDiffsJson(
        JSON.stringify([
          {
            old_path: "src/new.ts",
            new_path: "src/new.ts",
            new_file: true,
            b_mode: "100755",
            diff: "@@ -0,0 +1 @@\n+hello\n",
          },
          {
            old_path: "src/gone.ts",
            new_path: "src/gone.ts",
            deleted_file: true,
            diff: "@@ -1 +0,0 @@\n-bye\n",
          },
        ]),
      ),
    );

    expect(result.patch).toContain("new file mode 100755");
    expect(result.patch).toContain("--- /dev/null");
    expect(result.patch).toContain("deleted file mode 100644");
    expect(result.patch).toContain("+++ /dev/null");
  });

  it("reports truncation for a file GitLab refused to inline", () => {
    const result = expectSuccess(
      decodeMergeRequestDiffsJson(
        JSON.stringify([{ old_path: "big.bin", new_path: "big.bin", diff: "", too_large: true }]),
      ),
    );

    expect(result.truncated).toBe(true);
    expect(result.patch).toContain("diff --git a/big.bin b/big.bin");
  });

  it("reports how many files GitLab returned, so the caller can page", () => {
    const result = expectSuccess(
      decodeMergeRequestDiffsJson(
        JSON.stringify(
          Array.from({ length: 3 }, (_, index) => ({
            old_path: `src/${index}.ts`,
            new_path: `src/${index}.ts`,
            diff: "@@ -1 +1 @@\n-a\n+b\n",
          })),
        ),
      ),
    );

    expect(result.rawCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.patch).toContain("src/2.ts");
  });
});

describe("decodeTriggerJobChecksJson", () => {
  it("reads a downstream failure GitLab was told to allow as neutral, not failure", () => {
    const result = expectSuccess(
      decodeTriggerJobChecksJson(
        JSON.stringify([
          { name: "e2e", allow_failure: true, downstream_pipeline: { status: "failed" } },
          { name: "deploy", allow_failure: false, downstream_pipeline: { status: "running" } },
          { name: 7 },
        ]),
      ),
    );

    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ["e2e", "neutral"],
      ["deploy", "pending"],
    ]);
    expect(result.rawCount).toBe(3);
  });
});

describe("merge request viewer fields", () => {
  it("leaves merging permitted where GitLab answered without the field", () => {
    expect(expectSuccess(decodeMergeRequestDetailJson(detailJson({}))).viewerCanMerge).toBe(true);
    expect(
      expectSuccess(decodeMergeRequestDetailJson(detailJson({ user: null }))).viewerCanMerge,
    ).toBe(true);
  });
});

describe("decodeAwardEmojiJson", () => {
  it("reads MR-level awards, keys per-note awards by the REST id inside their gid, ignores an award outside the eight, and collects bot note authors", () => {
    const result = expectSuccess(
      decodeAwardEmojiJson(
        JSON.stringify({
          data: {
            currentUser: { username: "bilal" },
            project: {
              mergeRequest: {
                awardEmoji: {
                  nodes: [
                    { name: "thumbsup", user: { username: "bilal" } },
                    { name: "thumbsup", user: { username: "julius" } },
                  ],
                },
                notes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://gitlab/DiffNote/42",
                      author: { username: "julius", bot: false },
                      awardEmoji: { nodes: [{ name: "heart", user: { username: "julius" } }] },
                    },
                    {
                      id: "gid://gitlab/Note/7",
                      author: { username: "project_278964_bot_89f97e2c", bot: true },
                      awardEmoji: {
                        nodes: [{ name: "partyparrot", user: { username: "bilal" } }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    );

    expect(result.reactions).toEqual([
      { content: "thumbs-up", count: 2, actors: ["julius"], viewerHasReacted: true },
    ]);
    expect([...result.reactionsByNoteId]).toEqual([
      ["42", [{ content: "heart", count: 1, actors: ["julius"], viewerHasReacted: false }]],
    ]);
    expect([...result.botLogins]).toEqual(["project_278964_bot_89f97e2c"]);
    expect(result.nextCursor).toBeNull();
  });

  it("dates a note's edit only when someone edited its text, not when its thread was resolved", () => {
    const result = expectSuccess(
      decodeAwardEmojiJson(
        JSON.stringify({
          data: {
            currentUser: { username: "bilal" },
            project: {
              mergeRequest: {
                awardEmoji: { nodes: [] },
                notes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://gitlab/Note/1",
                      lastEditedAt: "2026-07-02T00:00:00Z",
                      lastEditedBy: { username: "julius" },
                      resolved: false,
                    },
                    {
                      id: "gid://gitlab/Note/2",
                      lastEditedAt: "2026-07-01T00:00:00Z",
                      lastEditedBy: null,
                      resolved: false,
                    },
                    {
                      id: "gid://gitlab/DiscussionNote/3",
                      lastEditedAt: "2026-07-03T00:00:00Z",
                      lastEditedBy: { username: "julius" },
                      resolved: true,
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    );

    expect([...result.editedAtByNoteId]).toEqual([["1", "2026-07-02T00:00:00Z"]]);
  });

  it("matches the viewer's username case-insensitively, since GitLab is not consistent about case", () => {
    const result = expectSuccess(
      decodeAwardEmojiJson(
        JSON.stringify({
          data: {
            currentUser: { username: "Bilal" },
            project: {
              mergeRequest: {
                awardEmoji: {
                  nodes: [
                    { name: "heart", user: { username: "bilal" } },
                    { name: "heart", user: { username: "julius" } },
                  ],
                },
                notes: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        }),
      ),
    );

    expect(result.reactions).toEqual([
      { content: "heart", count: 2, actors: ["julius"], viewerHasReacted: true },
    ]);
  });
});

describe("decodeOwnAwardIdJson", () => {
  const awards = JSON.stringify([
    { id: 101, name: "thumbsup", user: { username: "julius" } },
    { id: 102, name: "thumbsup", user: { username: "bilal" } },
  ]);

  it("finds the reader's own award of that name, which is the one a removal deletes", () => {
    expect(
      expectSuccess(decodeOwnAwardIdJson(awards, { content: "thumbs-up", viewer: "bilal" })),
    ).toEqual({ id: 102, empty: false });
  });
});

describe("decodeRepositoryBlobsJson", () => {
  function expectBlobs(result: Result.Result<ReadonlyMap<string, string> | null, unknown>) {
    const blobs = expectSuccess(result);
    expect(blobs).not.toBe(null);
    if (blobs === null) throw new Error("expected an answered blobs query");
    return blobs;
  }

  it("leaves out a node missing either half, which names no version", () => {
    const blobs = expectBlobs(
      decodeRepositoryBlobsJson(
        JSON.stringify({
          data: {
            project: {
              repository: {
                blobs: {
                  nodes: [
                    { path: "src/a.ts", oid: null },
                    { path: null, oid: "bbb222" },
                    null,
                    { path: "src/c.ts", oid: "ccc333" },
                  ],
                },
              },
            },
          },
        }),
      ),
    );

    expect([...blobs]).toEqual([["src/c.ts", "ccc333"]]);
  });

  it("keys a blob by the path the host spelled, spaces and all", () => {
    const blobs = expectBlobs(
      decodeRepositoryBlobsJson(
        JSON.stringify({
          data: {
            project: {
              repository: {
                blobs: {
                  nodes: [
                    { path: " leading.ts", oid: "aaa111" },
                    { path: "trailing.ts ", oid: "bbb222" },
                    { path: "   ", oid: "ccc333" },
                    { path: "", oid: "ddd444" },
                  ],
                },
              },
            },
          },
        }),
      ),
    );

    expect([...blobs]).toEqual([
      [" leading.ts", "aaa111"],
      ["trailing.ts ", "bbb222"],
      ["   ", "ccc333"],
    ]);
  });

  it("tells a project the reader cannot see from a revision with none of the files", () => {
    expect(
      expectSuccess(decodeRepositoryBlobsJson(JSON.stringify({ data: { project: null } }))),
    ).toBe(null);
    expect(
      expectSuccess(
        decodeRepositoryBlobsJson(JSON.stringify({ data: { project: { repository: null } } })),
      ),
    ).toBe(null);
    expect(
      expectSuccess(
        decodeRepositoryBlobsJson(
          JSON.stringify({ data: { project: { repository: { blobs: { nodes: [] } } } } }),
        ),
      ),
    ).toEqual(new Map());
  });
});

describe("decodeListStatesJson", () => {
  const statesOf = (enterprise: boolean | null, nodes: ReadonlyArray<unknown>) =>
    expectSuccess(
      decodeListStatesJson(
        JSON.stringify({
          data: {
            metadata: enterprise === null ? null : { enterprise },
            project: { mergeRequests: { nodes } },
          },
        }),
      ),
    );
  const approvedBy = (...usernames: ReadonlyArray<string>) => ({
    nodes: usernames.map((username) => ({ username })),
  });
  const reviewers = (...reviewStates: ReadonlyArray<string>) => ({
    nodes: reviewStates.map((reviewState) => ({ mergeRequestInteraction: { reviewState } })),
  });

  it.each([
    {
      reading: "an approval short of Enterprise approval rules",
      enterprise: true,
      approval: { approved: false, approvedBy: approvedBy("GitLabDuo") },
      decision: "review-required",
    },
    {
      reading: "Enterprise approval rules no one has approved against",
      enterprise: true,
      approval: { approved: false, approvedBy: approvedBy() },
      decision: "review-required",
    },
    {
      reading: "Enterprise approval rules met",
      enterprise: true,
      approval: { approved: true, approvedBy: approvedBy("julius") },
      decision: "approved",
    },
    {
      reading: "Enterprise without approval rules or approvals",
      enterprise: true,
      approval: { approved: true, approvedBy: approvedBy() },
      decision: null,
    },
    {
      reading: "Community Edition with an approval",
      enterprise: false,
      approval: { approved: true, approvedBy: approvedBy("julius") },
      decision: "approved",
    },
    {
      reading: "Community Edition without approvals",
      enterprise: false,
      approval: { approved: false, approvedBy: approvedBy() },
      decision: null,
    },
    {
      reading: "a reviewer requesting changes after another approved",
      enterprise: true,
      approval: {
        approved: true,
        approvedBy: approvedBy("julius"),
        reviewers: reviewers("APPROVED", "REQUESTED_CHANGES"),
      },
      decision: "changes-requested",
    },
    {
      reading: "a Community Edition reviewer requesting changes",
      enterprise: false,
      approval: {
        approved: false,
        approvedBy: approvedBy(),
        reviewers: reviewers("REQUESTED_CHANGES"),
      },
      decision: "changes-requested",
    },
    {
      reading: "reviewers who have not asked for changes",
      enterprise: false,
      approval: {
        approved: true,
        approvedBy: approvedBy("julius"),
        reviewers: reviewers("UNREVIEWED", "REVIEWED"),
      },
      decision: "approved",
    },
  ])("reads $reading as $decision", ({ enterprise, approval, decision }) => {
    expect([...statesOf(enterprise, [{ iid: "7", ...approval }])]).toEqual([
      [7, { reviewDecision: decision, checksState: null }],
    ]);
  });

  it.each([
    { pipeline: { status: "SUCCESS" }, checksState: "passing" },
    { pipeline: { status: "FAILED" }, checksState: "failing" },
    { pipeline: { status: "CANCELED" }, checksState: "failing" },
    { pipeline: { status: "RUNNING" }, checksState: "pending" },
    { pipeline: { status: "WAITING_FOR_RESOURCE" }, checksState: "pending" },
    { pipeline: { status: "MANUAL" }, checksState: null },
    { pipeline: { status: "SKIPPED" }, checksState: null },
    { pipeline: null, checksState: null },
  ])(
    "reads a $pipeline.status head pipeline as $checksState checks",
    ({ pipeline, checksState }) => {
      expect([
        ...statesOf(false, [
          { iid: "7", approved: false, approvedBy: approvedBy(), headPipeline: pipeline },
        ]),
      ]).toEqual([[7, { reviewDecision: null, checksState }]]);
    },
  );

  it("leaves out a merge request it cannot key, and a project the reader cannot see", () => {
    expect([...statesOf(true, [null, { iid: "x", approved: true }])]).toEqual([]);
    expect(
      expectSuccess(decodeListStatesJson(JSON.stringify({ data: { project: null } }))),
    ).toEqual(new Map());
  });

  it("keeps the checks of a merge request whose approval it cannot judge", () => {
    expect([
      ...statesOf(null, [
        {
          iid: "7",
          approved: false,
          approvedBy: approvedBy(),
          headPipeline: { status: "FAILED" },
        },
      ]),
      ...statesOf(true, [
        { iid: "8", approved: null, approvedBy: approvedBy("julius") },
        { iid: "9", approved: true, approvedBy: null },
      ]),
    ]).toEqual([
      [7, { checksState: "failing" }],
      [8, { checksState: null }],
      [9, { checksState: null }],
    ]);
  });
});

describe("decodeReferenceCandidatesJson", () => {
  it("prefixes merge requests with ! and skips malformed entries", () => {
    const raw = JSON.stringify([
      { iid: 5, title: "Ship it", state: "merged" },
      { iid: 6, title: "Draft", state: "opened" },
      { iid: 7, title: "Locked", state: "locked" },
      { title: "No iid", state: "opened" },
    ]);
    const decoded = decodeReferenceCandidatesJson(raw, "change-request");
    expect(Result.isSuccess(decoded) && decoded.success).toEqual({
      items: [
        { reference: "!5", kind: "change-request", number: 5, title: "Ship it", state: "merged" },
        { reference: "!6", kind: "change-request", number: 6, title: "Draft", state: "open" },
        { reference: "!7", kind: "change-request", number: 7, title: "Locked", state: "closed" },
      ],
      rawCount: 4,
    });
    const issues = decodeReferenceCandidatesJson(raw, "issue");
    expect(Result.isSuccess(issues) && issues.success.items[0]?.reference).toBe("#5");
  });
});

describe("decodeMergeRequestStatsJson", () => {
  it("keys the counts by merge request number", () => {
    const stats = expectSuccess(
      decodeMergeRequestStatsJson(
        JSON.stringify({
          data: {
            project: {
              mergeRequests: {
                nodes: [
                  { iid: "7", diffStatsSummary: { additions: 12, deletions: 3 } },
                  { iid: "8", diffStatsSummary: null },
                ],
              },
            },
          },
        }),
      ),
    );

    // A merge request without a summary is left out rather than shown as zero lines changed.
    expect([...stats]).toEqual([[7, { additions: 12, deletions: 3 }]]);
  });

  it("answers nothing for a project the token cannot see", () => {
    const stats = expectSuccess(
      decodeMergeRequestStatsJson(JSON.stringify({ data: { project: null } })),
    );

    expect(stats.size).toBe(0);
  });

  it("reports a file list shorter than the summary as truncated", () => {
    const read = (fileCount: number) =>
      expectSuccess(
        decodeMergeRequestFileStatsJson(
          JSON.stringify({
            data: {
              project: {
                mergeRequest: {
                  diffStatsSummary: { fileCount },
                  diffStats: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
                },
              },
            },
          }),
        ),
      );

    expect(read(1)).toEqual({
      files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
      truncated: false,
    });
    expect(read(2).truncated).toBe(true);
  });
});

describe("decodeMergeRequestGraphqlListJson", () => {
  it("reads a row and its review state in one page, counting rows it cannot read", () => {
    const page = expectSuccess(
      decodeMergeRequestGraphqlListJson(
        JSON.stringify({
          data: {
            metadata: { enterprise: false },
            project: {
              mergeRequests: {
                pageInfo: { hasNextPage: true, endCursor: "eyJpZCI6IjcifQ" },
                nodes: [
                  {
                    iid: "7",
                    title: "Add the merge requests page",
                    webUrl: "https://gitlab.com/acme/web/-/merge_requests/7",
                    state: "opened",
                    draft: true,
                    createdAt: "2026-07-01T00:00:00Z",
                    updatedAt: "2026-07-02T00:00:00Z",
                    sourceBranch: "feat/page",
                    targetBranch: "main",
                    conflicts: true,
                    mergeStatusEnum: "CHECKING",
                    author: { username: "bilal", name: "Bilal", avatarUrl: null },
                    labels: { nodes: [{ title: "bug" }] },
                    approved: false,
                    approvedBy: { nodes: [] },
                    reviewers: {
                      nodes: [
                        {
                          username: "julius",
                          mergeRequestInteraction: { reviewState: "REQUESTED_CHANGES" },
                        },
                      ],
                    },
                    headPipeline: { status: "FAILED" },
                  },
                  { iid: "8" },
                ],
              },
            },
          },
        }),
      ),
    );

    expect(page.items).toEqual([
      expect.objectContaining({
        number: 7,
        state: "open",
        isDraft: true,
        mergeability: "conflicting",
        reviewRequestLogins: ["julius"],
        labels: [expect.objectContaining({ name: "bug" })],
      }),
    ]);
    expect([...page.states]).toEqual([
      [7, { reviewDecision: "changes-requested", checksState: "failing" }],
    ]);
    expect(page).toMatchObject({ rawCount: 2, hasNextPage: true, endCursor: "eyJpZCI6IjcifQ" });
  });
  it("fails on a project the reader cannot see, rather than reading it as empty", () => {
    expect(
      Result.isFailure(
        decodeMergeRequestGraphqlListJson(
          JSON.stringify({ data: { metadata: { enterprise: true }, project: null } }),
        ),
      ),
    ).toBe(true);
  });
});

describe("decodeGraphqlListSupportJson", () => {
  it.each([
    { version: "17.8.4", supported: false },
    { version: "17.9.0", supported: true },
    { version: "19.6.0-pre", supported: true },
    { version: null, supported: false },
  ])("reads GitLab $version as supported: $supported", ({ version, supported }) => {
    expect(
      expectSuccess(
        decodeGraphqlListSupportJson(JSON.stringify({ data: { metadata: { version } } })),
      ),
    ).toBe(supported);
  });
});

describe("decodeMergeMessagesJson", () => {
  it("fails a partial response instead of reading errored fields as absent templates", () => {
    const decoded = decodeMergeMessagesJson(
      JSON.stringify({
        errors: [{ message: "Internal server error", path: ["project", "mergeRequest"] }],
        data: {
          project: { mergeRequest: { title: "Add thing", defaultMergeCommitMessage: null } },
        },
      }),
    );

    expect(Result.isFailure(decoded)).toBe(true);
  });
});
