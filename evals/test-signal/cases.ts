/**
 * Pull request test diffs for the test-signal check. A `real` case replays test files from a
 * merged PR. A `synthetic` case inserts one test into a real file at `rev`, for a pattern with no
 * clean real example.
 */
export type Case = {
  readonly id: string;
  readonly kind: "bad" | "guard";
  readonly source: string;
  readonly rev: string;
  /** Titles of the tests the check must flag. Guard cases expect no comment and `All clear`. */
  readonly targets: ReadonlyArray<{ readonly path: string; readonly title: string }>;
} & (
  | { readonly type: "real"; readonly paths: ReadonlyArray<string> }
  | {
      readonly type: "synthetic";
      readonly path: string;
      readonly after: string;
      readonly insert: string;
    }
);

const base = "cb7e3814d71c8fcdc5b803c660c29b7d7e39be96";

export const cases: ReadonlyArray<Case> = [
  {
    id: "copy-text-at-every-call-site",
    kind: "bad",
    source: "#23999 checks the PR or MR label in 11 files",
    type: "real",
    rev: "218e5c09df",
    paths: [
      "packages/client-runtime/src/state/gitActions.test.ts",
      "apps/web/src/lib/composerContextRecords.test.ts",
      "apps/mobile/src/lib/composerContext.test.ts",
    ],
    targets: [
      {
        path: "packages/client-runtime/src/state/gitActions.test.ts",
        title: "says PR for a GitHub ref",
      },
      {
        path: "packages/client-runtime/src/state/gitActions.test.ts",
        title: "says MR for a GitLab ref",
      },
      {
        path: "packages/client-runtime/src/state/gitActions.test.ts",
        title: "names the host's change request in the default-branch dialog",
      },
      {
        path: "apps/web/src/lib/composerContextRecords.test.ts",
        title: "names the change request the way its host does",
      },
      {
        path: "apps/mobile/src/lib/composerContext.test.ts",
        title: "describes the change request with its host's term",
      },
    ],
  },
  {
    id: "same-case-in-wrapper-test",
    kind: "bad",
    source: "#22452 added the same two cases to threadAccess and OrchestratorMcpService",
    type: "real",
    rev: "b260a7cf69",
    paths: [
      "apps/server/src/mcp/threadAccess.test.ts",
      "apps/server/src/mcp/OrchestratorMcpService.test.ts",
    ],
    // Either copy counts: the check must notice the duplicate. Which copy it keeps is secondary.
    targets: [
      {
        path: "apps/server/src/mcp/threadAccess.test.ts",
        title: "points a bare uuid at the mcp: thread it belongs to",
      },
      {
        path: "apps/server/src/mcp/threadAccess.test.ts",
        title: "keeps the plain message for an id that matches nothing",
      },
      {
        path: "apps/server/src/mcp/OrchestratorMcpService.test.ts",
        title: "points a bare uuid at the mcp: thread it belongs to",
      },
      {
        path: "apps/server/src/mcp/OrchestratorMcpService.test.ts",
        title: "keeps the plain message for an id that matches nothing",
      },
    ],
  },
  {
    id: "new-it-for-a-table-row",
    kind: "bad",
    source: "Synthetic: a new `it` next to the table that already covers it",
    type: "synthetic",
    rev: base,
    path: "packages/shared/src/markdownLinks.test.ts",
    after: "    expect(parseMarkdownFileLink(href)?.path).toBe(path);\n  });\n",
    insert:
      '\n  it("recognizes a Windows path with forward slashes as a file", () => {\n    expect(parseMarkdownFileLink("C:/repo/src/app.ts")?.path).toBe("C:/repo/src/app.ts");\n  });\n',
    targets: [
      {
        path: "packages/shared/src/markdownLinks.test.ts",
        title: "recognizes a Windows path with forward slashes as a file",
      },
    ],
  },
  {
    id: "mock-call-mirror",
    kind: "bad",
    source: "Synthetic: asserts the mock call the code makes, already covered above it",
    type: "synthetic",
    rev: base,
    path: "packages/client-runtime/src/state/threadRequests.test.ts",
    after: "    expect(send).toHaveBeenCalledOnce();\n  });\n",
    insert:
      '\n  it("calls respond with decline", async () => {\n    const respond = vi.fn<ApprovalResponder>(async () => AsyncResult.success(undefined));\n    await declinePendingApprovals([approval], respond);\n    expect(respond).toHaveBeenCalledWith(requestId, "decline");\n    expect(respond).toHaveBeenCalledTimes(1);\n  });\n',
    targets: [
      {
        path: "packages/client-runtime/src/state/threadRequests.test.ts",
        title: "calls respond with decline",
      },
    ],
  },
  {
    id: "type-guaranteed",
    kind: "bad",
    source: "Synthetic: checks a return type the signature already declares",
    type: "synthetic",
    rev: base,
    path: "packages/shared/src/markdownLinks.test.ts",
    after: "    expect(isMarkdownFileLinkLabel(label, href)).toBe(expected);\n  });\n",
    insert:
      '\n  it("returns a boolean", () => {\n    expect(typeof isMarkdownFileLinkLabel("a.ts", "/repo/a.ts")).toBe("boolean");\n  });\n',
    targets: [{ path: "packages/shared/src/markdownLinks.test.ts", title: "returns a boolean" }],
  },
  {
    id: "deadlock-race-fix",
    kind: "guard",
    source: "#22094 run metrics read lineage inside the transaction so a writer cannot deadlock",
    type: "real",
    rev: "f8e4834861",
    paths: ["apps/server/src/orchestration-v2/RunMetrics.test.ts"],
    targets: [],
  },
  {
    id: "clone-retry-fix",
    kind: "guard",
    source: "#23170 clones retry over HTTPS when the SSH key is refused",
    type: "real",
    rev: "a49d18cf3b",
    paths: ["apps/server/src/sourceControl/SourceControlRepositoryService.test.ts"],
    targets: [],
  },
  {
    id: "deleted-tests",
    kind: "guard",
    source: "#22592 pruned low-value tests",
    type: "real",
    rev: "a2f4df0412",
    paths: [
      "apps/server/src/workspace/WorkspaceEntries.test.ts",
      "apps/server/src/workspace/WorkspacePaths.test.ts",
    ],
    targets: [],
  },
  {
    id: "new-table-row",
    kind: "guard",
    source: "Synthetic: the right way to add the Windows path case",
    type: "synthetic",
    rev: base,
    path: "packages/shared/src/markdownLinks.test.ts",
    after: '    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],\n',
    insert: '    ["C:/repo/src/app.ts", "C:/repo/src/app.ts"],\n',
    targets: [],
  },
];
