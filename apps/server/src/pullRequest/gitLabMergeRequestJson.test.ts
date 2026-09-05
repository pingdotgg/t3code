import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeAwardEmojiJson,
  decodeCommitsJson,
  decodeMergeRequestDetailJson,
  decodeMergeRequestDiffsJson,
  decodeMergeRequestListJson,
  decodeNotesJson,
  decodeOwnAwardIdJson,
  decodeViewerJson,
  gitLabAwardName,
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

  it("reports no line counts, which GitLab does not expose", () => {
    const batch = expectSuccess(decodeMergeRequestListJson(listJson([{}])));

    expect(batch.items[0]).toMatchObject({ additions: 0, deletions: 0 });
  });

  it("treats a merged timestamp as merged whatever the state says", () => {
    const batch = expectSuccess(
      decodeMergeRequestListJson(
        listJson([{ state: "opened", merged_at: "2026-07-03T00:00:00Z" }]),
      ),
    );

    expect(batch.items[0]?.state).toBe("merged");
  });

  it("keeps a locked merge request open", () => {
    const batch = expectSuccess(decodeMergeRequestListJson(listJson([{ state: "locked" }])));

    expect(batch.items[0]?.state).toBe("open");
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

  it("leaves an unfinished merge check unknown", () => {
    const batch = expectSuccess(
      decodeMergeRequestListJson(listJson([{ merge_status: "checking" }])),
    );

    expect(batch.items[0]?.mergeability).toBe("unknown");
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

  it("reads an uncounted change set as its floor", () => {
    const detail = expectSuccess(
      decodeMergeRequestDetailJson(detailJson({ changes_count: "1000+" })),
    );

    expect(detail.changedFiles).toBe(1000);
  });

  it("falls back to no file count when GitLab omits one", () => {
    const detail = expectSuccess(decodeMergeRequestDetailJson(detailJson({})));

    expect(detail.changedFiles).toBe(0);
  });

  it("reads either auto-merge field, and says nothing where GitLab named neither", () => {
    const armed = (entry: Record<string, unknown>) =>
      expectSuccess(decodeMergeRequestDetailJson(detailJson(entry))).autoMergeEnabled;

    expect(armed({ merge_when_pipeline_succeeds: true })).toBe(true);
    // The newer name for the same fact, which older GitLab installs do not send.
    expect(armed({ auto_merge_enabled: true })).toBe(true);
    expect(armed({ merge_when_pipeline_succeeds: false })).toBe(false);
    // Absent is GitLab not saying, which the page must not read as "not armed".
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
    // Counted and found level, which is the one answer that entitles the page to say so.
    expect(behind({ diverged_commits_count: 0 })).toBe(0);
    // An install that does not answer, and a null where the answer would have gone, are both
    // silence: reading either as zero would tell a stale branch it is current.
    expect(behind({})).toBeUndefined();
    expect(behind({ diverged_commits_count: null })).toBeUndefined();
  });

  it("maps a pipeline waiting on a person to neutral, not failure", () => {
    const detail = expectSuccess(
      decodeMergeRequestDetailJson(detailJson({ head_pipeline: { status: "manual" } })),
    );

    expect(detail.checks[0]?.status).toBe("neutral");
  });
});

describe("decodeViewerJson", () => {
  it("reads the signed-in username", () => {
    expect(expectSuccess(decodeViewerJson(JSON.stringify({ username: "bilal" })))).toBe("bilal");
  });

  it("returns nothing when the account has no username", () => {
    expect(expectSuccess(decodeViewerJson(JSON.stringify({ username: "  " })))).toBeNull();
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
    // The raw count keeps the dropped notes visible to the caller, which needs them to page.
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
  it("returns commits oldest first", () => {
    const commits = expectSuccess(
      decodeCommitsJson(
        JSON.stringify([
          { id: "bbb", title: "second", committed_date: "2026-07-02T00:00:00Z" },
          { id: "aaa", title: "first", committed_date: "2026-07-01T00:00:00Z" },
        ]),
      ),
    );

    expect(commits.map((commit) => commit.oid)).toEqual(["aaa", "bbb"]);
  });

  it("skips commits whose id is empty", () => {
    const commits = expectSuccess(
      decodeCommitsJson(
        JSON.stringify([
          { id: "   ", title: "invalid", committed_date: "2026-07-02T00:00:00Z" },
          { id: "aaa", committed_date: "2026-07-01T00:00:00Z" },
        ]),
      ),
    );

    expect(commits.map((commit) => commit.oid)).toEqual(["aaa"]);
  });

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

  it("carries commit additions and deletions when GitLab returns stats", () => {
    const commits = expectSuccess(
      decodeCommitsJson(
        JSON.stringify([
          {
            id: "aaa",
            committed_date: "2026-07-01T00:00:00Z",
            stats: { additions: 21, deletions: 8, total: 29 },
          },
        ]),
      ),
    );

    expect(commits[0]).toMatchObject({ additions: 21, deletions: 8 });
  });
});

describe("decodeMergeRequestDiffsJson", () => {
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

  it("records a rename so the patch names both paths", () => {
    const result = expectSuccess(
      decodeMergeRequestDiffsJson(
        JSON.stringify([
          { old_path: "src/old.ts", new_path: "src/new.ts", renamed_file: true, diff: "" },
        ]),
      ),
    );

    expect(result.patch).toContain("rename from src/old.ts");
    expect(result.patch).toContain("rename to src/new.ts");
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

  it("fails when GitLab did not return a list", () => {
    expect(Result.isFailure(decodeMergeRequestDiffsJson('{"message":"404"}'))).toBe(true);
  });
});

describe("merge request viewer fields", () => {
  it("carries GitLab's own answer for whether this viewer can merge", () => {
    expect(
      expectSuccess(decodeMergeRequestDetailJson(detailJson({ user: { can_merge: false } })))
        .viewerCanMerge,
    ).toBe(false);
    expect(
      expectSuccess(decodeMergeRequestDetailJson(detailJson({ user: { can_merge: true } })))
        .viewerCanMerge,
    ).toBe(true);
  });

  it("leaves merging permitted where GitLab answered without the field", () => {
    // Only the single-merge-request endpoint carries `user`, and an install that answers without
    // it has said nothing about the viewer rather than said no.
    expect(expectSuccess(decodeMergeRequestDetailJson(detailJson({}))).viewerCanMerge).toBe(true);
    expect(
      expectSuccess(decodeMergeRequestDetailJson(detailJson({ user: null }))).viewerCanMerge,
    ).toBe(true);
  });
});

describe("decodeAwardEmojiJson", () => {
  it("reads MR-level awards, keys per-note awards by the REST id inside their gid, and ignores an award outside the eight", () => {
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
                      awardEmoji: { nodes: [{ name: "heart", user: { username: "julius" } }] },
                    },
                    {
                      id: "gid://gitlab/Note/7",
                      // Not one of the eight the contract carries.
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

    // `bilal` is `currentUser`, so the group they are in reads back as reacted, but their own
    // username is left out of `actors` — the page names them "You" instead — while `count` still
    // counts them; `julius` alone does not turn a group's own `viewerHasReacted` on.
    expect(result.reactions).toEqual([
      { content: "thumbs-up", count: 2, actors: ["julius"], viewerHasReacted: true },
    ]);
    // Note 7's only award named nobody the eight recognise, so it carries no reactions and is
    // left out of the map rather than kept empty.
    expect([...result.reactionsByNoteId]).toEqual([
      ["42", [{ content: "heart", count: 1, actors: ["julius"], viewerHasReacted: false }]],
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("hands back a cursor when GitLab has more notes to page", () => {
    const result = expectSuccess(
      decodeAwardEmojiJson(
        JSON.stringify({
          data: {
            currentUser: null,
            project: {
              mergeRequest: {
                awardEmoji: { nodes: [] },
                notes: { pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29yOjE" }, nodes: [] },
              },
            },
          },
        }),
      ),
    );

    expect(result.nextCursor).toBe("Y3Vyc29yOjE");
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
    ).toBe(102);
  });

  it("returns nothing where the reader has no award of that name", () => {
    expect(
      expectSuccess(decodeOwnAwardIdJson(awards, { content: "heart", viewer: "bilal" })),
    ).toBeNull();
  });
});

describe("gitLabAwardName", () => {
  it("spells the contents whose GitLab award name is not their own kebab-case", () => {
    expect(gitLabAwardName("thumbs-up")).toBe("thumbsup");
    expect(gitLabAwardName("laugh")).toBe("laughing");
    expect(gitLabAwardName("hooray")).toBe("tada");
  });
});
