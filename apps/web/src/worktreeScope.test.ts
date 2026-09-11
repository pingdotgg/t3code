import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { worktreeResourceThreadId } from "@t3tools/shared/worktreeResource";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import {
  migrateWorktreeScopedRecordKeys,
  resolveWorktreeCanonicalThreadRef,
  resolveWorktreeScopeKeyForThreadRef,
  threadWorktreeScopeKey,
  worktreeCanonicalThreadRefsByScopeKey,
  worktreeRepresentativeThreadRefsByScopeKey,
  worktreeScopeKey,
} from "./worktreeScope";

describe("worktreeScope", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
  });

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

  it("keeps established worktree state when stale draft state also exists", () => {
    const fallbackKey = "environment-1:thread-1";
    const primaryKey = "environment-1:project-1:/repo/worktree";
    const worktreeState = { isOpen: true };

    expect(
      migrateWorktreeScopedRecordKeys(
        {
          [primaryKey]: worktreeState,
          [fallbackKey]: { isOpen: false },
        },
        primaryKey,
        fallbackKey,
      ),
    ).toEqual({
      key: primaryKey,
      record: { [primaryKey]: worktreeState },
    });
  });

  it("resolves synthetic worktree owner refs to the checkout scope without a shell", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");
    const worktreePath = "/repo/worktree";
    const canonicalRef = scopeThreadRef(
      environmentId,
      worktreeResourceThreadId(projectId, worktreePath),
    );

    expect(resolveWorktreeScopeKeyForThreadRef(canonicalRef)).toBe(
      worktreeScopeKey(environmentId, projectId, worktreePath),
    );
  });

  it("uses the final checkout scope and resource owner before a draft is sent", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const threadRef = scopeThreadRef(environmentId, threadId);
    const worktreePath = "/repo/worktree";

    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), DraftId.make("draft-1"), {
        threadId,
        worktreePath,
      });

    expect(resolveWorktreeScopeKeyForThreadRef(threadRef)).toBe(
      worktreeScopeKey(environmentId, projectId, worktreePath),
    );
    expect(resolveWorktreeCanonicalThreadRef(threadRef).threadId).toBe(
      worktreeResourceThreadId(projectId, worktreePath),
    );
  });

  it("keeps a real thread ref available for checkout-scoped UI metadata", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");
    const worktreePath = "/repo/worktree";
    const first = {
      environmentId,
      id: ThreadId.make("thread-1"),
      projectId,
      worktreePath,
    } as EnvironmentThreadShell;
    const second = {
      environmentId,
      id: ThreadId.make("thread-2"),
      projectId,
      worktreePath,
    } as EnvironmentThreadShell;
    const scopeKey = threadWorktreeScopeKey(first);

    expect(worktreeRepresentativeThreadRefsByScopeKey([first, second]).get(scopeKey)).toEqual(
      scopeThreadRef(environmentId, first.id),
    );
    expect(worktreeCanonicalThreadRefsByScopeKey([first, second]).get(scopeKey)?.threadId).toBe(
      worktreeResourceThreadId(projectId, worktreePath),
    );
  });
});
