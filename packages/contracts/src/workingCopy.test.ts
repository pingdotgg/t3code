import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  WorkingCopyBatchResult,
  WorkingCopyCommitDetail,
  WorkingCopyCommitHash,
  WorkingCopyCwdDeniedError,
  WorkingCopyDiscardResult,
  WorkingCopyError,
  WorkingCopyCommitMessageError,
  WorkingCopyFile,
  WorkingCopyGenerateCommitMessageInput,
  WorkingCopyGeneratedCommitMessage,
  WorkingCopyIndexLockedError,
  WorkingCopyInvalidRevisionError,
  WorkingCopyLogEntry,
  WorkingCopyLogInput,
  WorkingCopyLogPage,
  WorkingCopyNothingStagedError,
  WorkingCopyStashEntry,
  WorkingCopyStatusResult,
} from "./workingCopy.ts";

/** Every schema in this module decodes and encodes without services. */
type PureSchema = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

const roundTrip = <S extends PureSchema>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema)(Schema.decodeUnknownSync(schema)(value));

const decodes = <S extends PureSchema>(schema: S, value: unknown) =>
  Schema.decodeUnknownResult(schema)(value)._tag === "Success";

const decodeStatus = Schema.decodeUnknownSync(WorkingCopyStatusResult);
const decodeLogEntry = Schema.decodeUnknownSync(WorkingCopyLogEntry);

describe("WorkingCopyFile", () => {
  it("round-trips a plain modification and a rename", () => {
    const modified = { path: "src/a.ts", area: "staged", change: "modified" };
    const renamed = {
      path: "src/new.ts",
      area: "staged",
      change: "renamed",
      oldPath: "src/old.ts",
      insertions: 3,
      deletions: 1,
    };

    expect(roundTrip(WorkingCopyFile, modified)).toEqual(modified);
    expect(roundTrip(WorkingCopyFile, renamed)).toEqual(renamed);
  });

  it("rejects an area or change outside the union", () => {
    expect(decodes(WorkingCopyFile, { path: "a", area: "untracked", change: "modified" })).toBe(
      false,
    );
    expect(decodes(WorkingCopyFile, { path: "a", area: "unstaged", change: "moved" })).toBe(false);
  });

  it("rejects negative counts", () => {
    expect(
      decodes(WorkingCopyFile, {
        path: "a",
        area: "staged",
        change: "modified",
        insertions: -1,
      }),
    ).toBe(false);
  });
});

describe("WorkingCopyStatusResult", () => {
  it("round-trips a clean repository with no upstream and no numbers", () => {
    const value = {
      isRepo: true,
      refName: "main",
      detached: false,
      hasUpstream: false,
      files: [],
      operationInProgress: null,
    };

    expect(roundTrip(WorkingCopyStatusResult, value)).toEqual(value);
  });

  it("round-trips a detached HEAD mid-rebase with ahead/behind", () => {
    const value = {
      isRepo: true,
      refName: null,
      detached: true,
      ahead: 2,
      behind: 5,
      hasUpstream: true,
      files: [{ path: "a.ts", area: "conflicted", change: "unmerged" }],
      operationInProgress: "rebase",
    };

    expect(roundTrip(WorkingCopyStatusResult, value)).toEqual(value);
  });

  it("keeps `ahead` absent rather than defaulting it to zero", () => {
    const decoded = decodeStatus({
      isRepo: true,
      refName: "main",
      detached: false,
      hasUpstream: false,
      files: [],
      operationInProgress: null,
    });

    expect("ahead" in decoded).toBe(false);
  });
});

describe("WorkingCopyLogEntry", () => {
  it("round-trips a merge commit with two parents and an empty subject", () => {
    const value = {
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      subject: "",
      authorName: "Ada",
      authorEmail: "ada@example.com",
      authoredAt: "2024-05-01T10:00:00+02:00",
      parents: ["b".repeat(40), "c".repeat(40)],
    };

    expect(roundTrip(WorkingCopyLogEntry, value)).toEqual(value);
  });

  it("exposes exactly the field names the client's pure modules read", () => {
    const decoded = decodeLogEntry({
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      subject: "s",
      authorName: "Ada",
      authorEmail: "ada@example.com",
      authoredAt: "2024-05-01T10:00:00+02:00",
      parents: [],
    });

    expect(Object.keys(decoded).sort()).toEqual([
      "authorEmail",
      "authorName",
      "authoredAt",
      "hash",
      "parents",
      "shortHash",
      "subject",
    ]);
  });
});

describe("WorkingCopyLogPage", () => {
  it("always carries hasMore", () => {
    expect(decodes(WorkingCopyLogPage, { entries: [] })).toBe(false);
    expect(roundTrip(WorkingCopyLogPage, { entries: [], hasMore: true })).toEqual({
      entries: [],
      hasMore: true,
    });
  });
});

describe("WorkingCopyCommitDetail", () => {
  it("round-trips a full drawer payload", () => {
    const value = {
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      subject: "feat: thing",
      body: "line one\nline two",
      authorName: "Ada",
      authorEmail: "ada@example.com",
      authoredAt: "2024-05-01T10:00:00+02:00",
      parents: ["b".repeat(40)],
      files: [{ path: "a.ts", change: "modified", insertions: 2, deletions: 1 }],
      insertions: 2,
      deletions: 1,
      refs: [
        { name: "HEAD", kind: "head" },
        { name: "v1.0.0", kind: "tag" },
      ],
    };

    expect(roundTrip(WorkingCopyCommitDetail, value)).toEqual(value);
  });
});

describe("results the undo ladder depends on", () => {
  it("always carries `recoverable` on a discard result", () => {
    expect(decodes(WorkingCopyDiscardResult, { discardedPaths: [] })).toBe(false);
    const value = { recoverable: true, backupRef: "stash@{0}", discardedPaths: ["a.ts"] };
    expect(roundTrip(WorkingCopyDiscardResult, value)).toEqual(value);
    expect(roundTrip(WorkingCopyDiscardResult, { recoverable: false, discardedPaths: [] })).toEqual(
      { recoverable: false, discardedPaths: [] },
    );
  });

  it("round-trips a partially applied batch", () => {
    const value = { staged: 2, failed: { paths: ["c.ts"], detail: "fatal: pathspec" } };

    expect(roundTrip(WorkingCopyBatchResult, value)).toEqual(value);
    expect(roundTrip(WorkingCopyBatchResult, { staged: 3 })).toEqual({ staged: 3 });
  });

  it("round-trips a stash entry, including the backup flag", () => {
    const value = {
      index: 0,
      ref: "stash@{0}",
      label: "t3-backup: 2 path(s)",
      branch: "main",
      createdAt: "2024-05-01T10:00:00+02:00",
      isDiscardBackup: true,
    };

    expect(roundTrip(WorkingCopyStashEntry, value)).toEqual(value);
  });
});

describe("WorkingCopyCommitHash", () => {
  it("accepts an abbreviated or full object name", () => {
    expect(decodes(WorkingCopyCommitHash, "abcd")).toBe(true);
    expect(decodes(WorkingCopyCommitHash, "a".repeat(40))).toBe(true);
    expect(decodes(WorkingCopyCommitHash, "DEADBEEF")).toBe(true);
  });

  it("rejects a revision expression or an option, which would reach git as argv", () => {
    for (const rejected of ["HEAD", "HEAD~1", "main", "--upload-pack=x", "abc", "a".repeat(41)]) {
      expect(decodes(WorkingCopyCommitHash, rejected)).toBe(false);
    }
  });

  it("gates the log cursor, so a bad cursor never reaches the server logic", () => {
    expect(decodes(WorkingCopyLogInput, { cwd: "/repo", before: "HEAD~1" })).toBe(false);
    expect(decodes(WorkingCopyLogInput, { cwd: "/repo", before: "a".repeat(40) })).toBe(true);
  });
});

describe("WorkingCopyError", () => {
  it("accepts the fork's own failures", () => {
    const isError = Schema.is(WorkingCopyError);

    expect(
      isError(new WorkingCopyCwdDeniedError({ operation: "workingCopy.status", cwd: "/x" })),
    ).toBe(true);
    expect(
      isError(new WorkingCopyInvalidRevisionError({ operation: "workingCopy.log", rev: "HEAD" })),
    ).toBe(true);
    expect(
      isError(
        new WorkingCopyIndexLockedError({
          operation: "workingCopy.stagePaths",
          cwd: "/x",
          attempts: 4,
        }),
      ),
    ).toBe(true);
  });

  it("still accepts the inherited VcsError taxonomy rather than minting a new one", () => {
    expect(
      decodes(WorkingCopyError, {
        _tag: "VcsProcessExitError",
        operation: "workingCopy.commitStaged",
        command: "git",
        cwd: "/x",
        exitCode: 1,
        detail: "error: pre-commit hook failed",
      }),
    ).toBe(true);
  });

  it("fails closed on an unknown tag", () => {
    expect(decodes(WorkingCopyError, { _tag: "SomethingElse" })).toBe(false);
  });
});

// ─── fork: f4 AI commit message ─────────────────────────────────────────────

describe("WorkingCopyGenerateCommitMessageInput", () => {
  it("round-trips with and without the amend flag", () => {
    const plain = { cwd: "/work/proj" };
    const amending = { cwd: "/work/proj", amend: true };

    expect(roundTrip(WorkingCopyGenerateCommitMessageInput, plain)).toEqual(plain);
    expect(roundTrip(WorkingCopyGenerateCommitMessageInput, amending)).toEqual(amending);
  });

  it("carries no paths and no message — the index is the only input", () => {
    expect(decodes(WorkingCopyGenerateCommitMessageInput, { cwd: "" })).toBe(false);
  });
});

describe("WorkingCopyGeneratedCommitMessage", () => {
  it("round-trips a subject-only message with an empty body", () => {
    const value = { subject: "Add the thing", body: "", message: "Add the thing" };
    expect(roundTrip(WorkingCopyGeneratedCommitMessage, value)).toEqual(value);
  });

  it("requires all three fields, so a caller cannot re-derive the join wrongly", () => {
    expect(decodes(WorkingCopyGeneratedCommitMessage, { subject: "s", body: "b" })).toBe(false);
  });
});

describe("WorkingCopyCommitMessageError", () => {
  it("accepts the generation-only failures", () => {
    expect(
      decodes(WorkingCopyCommitMessageError, {
        _tag: "WorkingCopyNothingStagedError",
        operation: "workingCopy.generateCommitMessage",
        cwd: "/work/proj",
        amend: false,
      }),
    ).toBe(true);
    expect(
      decodes(WorkingCopyCommitMessageError, {
        _tag: "TextGenerationError",
        operation: "generateCommitMessage",
        detail: "codex is not on PATH",
      }),
    ).toBe(true);
  });

  it("still accepts every inherited working-copy failure", () => {
    expect(
      decodes(WorkingCopyCommitMessageError, {
        _tag: "WorkingCopyCwdDeniedError",
        operation: "workingCopy.generateCommitMessage",
        cwd: "/elsewhere",
      }),
    ).toBe(true);
  });

  it("the base union stays narrow — generation failures are NOT in WorkingCopyError", () => {
    // Widening `WorkingCopyError` would change the decoded error type of all
    // 28 pre-existing methods for one method's benefit.
    expect(
      decodes(WorkingCopyError, {
        _tag: "WorkingCopyNothingStagedError",
        operation: "workingCopy.generateCommitMessage",
        cwd: "/work/proj",
        amend: false,
      }),
    ).toBe(false);
  });

  it("wording distinguishes the amend case", () => {
    expect(
      new WorkingCopyNothingStagedError({
        operation: "workingCopy.generateCommitMessage",
        cwd: "/work/proj",
        amend: false,
      }).message,
    ).toContain("Stage some changes first");
    expect(
      new WorkingCopyNothingStagedError({
        operation: "workingCopy.generateCommitMessage",
        cwd: "/work/proj",
        amend: true,
      }).message,
    ).toContain("amended commit would be empty");
  });
});
