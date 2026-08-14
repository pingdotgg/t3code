import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

const composerDraftFileMocks = vi.hoisted(() => {
  let document = "";
  let writeError: Error | null = null;
  let releaseRead: (() => void) | null = null;
  let readBarrier = Promise.resolve();

  return {
    blockRead() {
      readBarrier = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseRead() {
      releaseRead?.();
      releaseRead = null;
    },
    getDocument() {
      return document;
    },
    setDocument(value: unknown) {
      document = JSON.stringify(value);
    },
    setWriteError(error: Error | null) {
      writeError = error;
    },
    Directory: class {
      create() {}
    },
    File: class {
      exists = true;
      parentDirectory = null;

      create() {}

      moveSync() {}

      async text() {
        await readBarrier;
        return document;
      }

      write(value: string) {
        if (writeError) {
          throw writeError;
        }
        document = value;
      }
    },
  };
});

vi.mock("expo-file-system", () => ({
  Directory: composerDraftFileMocks.Directory,
  File: composerDraftFileMocks.File,
  Paths: { document: "/documents" },
}));

import { appAtomRegistry } from "./atom-registry";
import {
  clearComposerDraftContentState,
  ComposerDraftPersistenceError,
  composerDraftsAtom,
  copyComposerDraftContentIfEmpty,
  copyComposerDraftContentState,
  decodePersistedComposerDrafts,
  type ComposerDraft,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContentState,
  removeComposerDraftsForEnvironment,
  restoreComposerDraftSnapshotState,
  setComposerDraftText,
} from "./use-composer-drafts";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};

afterEach(() => {
  appAtomRegistry.set(composerDraftsAtom, {});
});

describe("mobile composer drafts", () => {
  it("hydrates selector state even when the message content is empty", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "new-task:environment-1:project-1": {
            text: "",
            attachments: [],
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            workspaceSelection: {
              mode: "worktree",
              branch: "main",
              worktreePath: null,
            },
          },
        },
      }),
    ).toEqual({
      "new-task:environment-1:project-1": {
        text: "",
        attachments: [],
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspaceSelection: {
          mode: "worktree",
          branch: "main",
          worktreePath: null,
        },
      },
    });
  });

  it("keeps legacy content-only drafts and rejects invalid selector state", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": DRAFT,
        },
      }),
    ).toEqual({
      "environment-1:thread-1": DRAFT,
    });

    expect(() =>
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": {
            ...DRAFT,
            runtimeMode: "sometimes-safe",
          },
        },
      }),
    ).toThrow();
  });

  it("clears sent content without clearing the selected model or workspace", () => {
    const draftKey = "environment-1:thread-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      importedShareIds: ["share-1"],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
      },
    };

    expect(clearComposerDraftContentState({ [draftKey]: draft }, draftKey)).toEqual({
      [draftKey]: {
        modelSelection: draft.modelSelection,
        workspaceSelection: draft.workspaceSelection,
        text: "",
        attachments: [],
      },
    });
  });

  it("drops the workspace selection when clearing a sent new-task draft", () => {
    const draftKey = "new-task:environment-1:project-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: false,
      },
    };

    expect(
      clearComposerDraftContentState({ [draftKey]: draft }, draftKey, {
        clearWorkspaceSelection: true,
      }),
    ).toEqual({
      [draftKey]: {
        modelSelection: draft.modelSelection,
        text: "",
        attachments: [],
      },
    });
  });

  it("reads the latest selector state synchronously for send", () => {
    const draftKey = "environment-1:thread-1";
    const selectedDraft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    };
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: selectedDraft });

    expect(getComposerDraftSnapshot(draftKey)).toEqual(selectedDraft);
  });

  it("carries unfinished content to a newly selected project without overwriting its settings", () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const source: ComposerDraft = {
      text: "Keep this task",
      attachments: [],
      importedShareIds: ["share-1"],
      workspaceSelection: {
        mode: "worktree",
        branch: "feature/source",
        worktreePath: null,
      },
    };
    const target: ComposerDraft = {
      text: "",
      attachments: [],
      runtimeMode: "approval-required",
    };

    expect(
      copyComposerDraftContentState(
        { [sourceKey]: source, [targetKey]: target },
        sourceKey,
        targetKey,
      ),
    ).toEqual({
      [sourceKey]: source,
      [targetKey]: {
        ...target,
        text: source.text,
        attachments: source.attachments,
        importedShareIds: source.importedShareIds,
      },
    });
  });

  it("does not overwrite unfinished content already stored for the selected project", () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const drafts: Record<string, ComposerDraft> = {
      [sourceKey]: { text: "Source task", attachments: [] },
      [targetKey]: { text: "Target task", attachments: [] },
    };

    expect(copyComposerDraftContentState(drafts, sourceKey, targetKey)).toBe(drafts);
  });

  it("merges shared content into a project draft without duplicating retries", () => {
    const draftKey = "new-task:environment-1:project-1";
    const sharedAttachment = {
      id: "share-1:image:0",
      type: "image" as const,
      name: "Screenshot.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
    };
    const existing: Record<string, ComposerDraft> = {
      [draftKey]: { text: "Existing context", attachments: [] },
    };
    const content = {
      text: "Shared note",
      attachments: [sharedAttachment],
      sourceShareId: "share-1",
    };

    const merged = mergeComposerDraftContentState(existing, draftKey, content);
    expect(merged[draftKey]).toMatchObject({
      text: "Existing context\n\nShared note",
      attachments: [sharedAttachment],
      importedShareIds: ["share-1"],
    });
    expect(mergeComposerDraftContentState(merged, draftKey, content)).toBe(merged);

    const edited = {
      ...merged,
      [draftKey]: { ...merged[draftKey]!, text: "User edited the imported context" },
    };
    expect(mergeComposerDraftContentState(edited, draftKey, content)).toBe(edited);
  });

  it("preserves existing images when shared content exceeds the draft attachment limit", () => {
    const draftKey = "new-task:environment-1:project-1";
    const image = (id: string) => ({
      id,
      type: "image" as const,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
    });
    const existingImage = image("existing");
    const sharedImages = Array.from({ length: 8 }, (_, index) => image(`shared-${index}`));

    const merged = mergeComposerDraftContentState(
      { [draftKey]: { text: "", attachments: [existingImage] } },
      draftKey,
      { text: "", attachments: sharedImages },
    );

    expect(merged[draftKey]?.attachments).toHaveLength(8);
    expect(merged[draftKey]?.attachments[0]).toEqual(existingImage);
    expect(merged[draftKey]?.attachments.at(-1)?.id).toBe("shared-6");
  });

  it("restores the exact draft captured before an interrupted share import", () => {
    const draftKey = "new-task:environment-1:project-1";
    const beforeImport: ComposerDraft = {
      text: "Existing context",
      attachments: [],
      runtimeMode: "approval-required",
    };
    const imported: ComposerDraft = {
      ...beforeImport,
      text: "Existing context\n\nShared note",
      importedShareIds: ["share-1"],
    };

    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, beforeImport),
    ).toEqual({ [draftKey]: beforeImport });
    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, {
        text: "",
        attachments: [],
      }),
    ).toEqual({});
  });

  it("removes only drafts owned by the selected environment", () => {
    const environmentId = EnvironmentId.make("environment-cloud");
    const retainedEnvironmentId = EnvironmentId.make("environment-local");

    expect(
      removeComposerDraftsForEnvironment(
        {
          [`${environmentId}:thread-cloud`]: DRAFT,
          [`new-task:${environmentId}:project-cloud`]: DRAFT,
          [`${retainedEnvironmentId}:thread-local`]: DRAFT,
          [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
        },
        environmentId,
      ),
    ).toEqual({
      [`${retainedEnvironmentId}:thread-local`]: DRAFT,
      [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
    });
  });

  it("waits for persisted drafts before copying content between projects", async () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const unrelatedKey = "environment-1:thread-1";
    const source = { text: "Current task", attachments: [] } satisfies ComposerDraft;
    const target = { text: "Persisted target", attachments: [] } satisfies ComposerDraft;
    const unrelated = { text: "Keep me", attachments: [] } satisfies ComposerDraft;

    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {
        [targetKey]: target,
        [unrelatedKey]: unrelated,
      },
    });
    composerDraftFileMocks.blockRead();
    appAtomRegistry.set(composerDraftsAtom, { [sourceKey]: source });

    const copy = copyComposerDraftContentIfEmpty(sourceKey, targetKey);
    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({ [sourceKey]: source });

    composerDraftFileMocks.releaseRead();
    await copy;

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({
      [sourceKey]: source,
      [targetKey]: target,
      [unrelatedKey]: unrelated,
    });
  });

  it("lands a still-debounced draft write when flushed", async () => {
    const draftKey = "environment-1:thread-1";
    setComposerDraftText(draftKey, "typed right before the restart");

    await flushComposerDrafts();

    expect(JSON.parse(composerDraftFileMocks.getDocument())).toMatchObject({
      drafts: { [draftKey]: { text: "typed right before the restart" } },
    });
  });

  it("propagates a flush write failure instead of resolving as saved", async () => {
    const draftKey = "environment-1:thread-1";
    setComposerDraftText(draftKey, "unsaved");
    composerDraftFileMocks.setWriteError(new Error("storage unavailable"));

    try {
      await expect(flushComposerDrafts()).rejects.toBeInstanceOf(ComposerDraftPersistenceError);
    } finally {
      composerDraftFileMocks.setWriteError(null);
    }
  });
});
