import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  migrateWorktreeScopedRecordKeys,
  selectStableCanonicalThreadId,
  worktreeScopeKey,
} from "./worktreeScope";

describe("worktreeScope", () => {
  it("preserves whitespace that is part of a filesystem path", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");

    expect(worktreeScopeKey(environmentId, projectId, "/repo/worktree")).not.toBe(
      worktreeScopeKey(environmentId, projectId, "/repo/worktree "),
    );
  });

  it("migrates draft-scoped state when the worktree shell materializes", () => {
    const fallbackKey = "environment-1:thread-1";
    const primaryKey = "environment-1:project-1:/repo/worktree";
    const draftState = { isOpen: true };

    const migrated = migrateWorktreeScopedRecordKeys(
      { [fallbackKey]: draftState },
      primaryKey,
      fallbackKey,
    );

    expect(migrated).toEqual({
      key: primaryKey,
      record: { [primaryKey]: draftState },
    });
  });

  it("retains a remembered canonical owner after it leaves the candidate set", () => {
    const rememberedThreadId = ThreadId.make("thread-oldest");
    const remainingThreadId = ThreadId.make("thread-sibling");

    expect(
      selectStableCanonicalThreadId(
        [{ id: remainingThreadId, createdAt: "2026-01-02T00:00:00.000Z" }],
        rememberedThreadId,
      ),
    ).toBe(rememberedThreadId);
  });
});
