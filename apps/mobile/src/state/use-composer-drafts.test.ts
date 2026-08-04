import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import {
  clearComposerDraftsEnvironmentState,
  clearComposerDraftContentState,
  composerDraftsAtom,
  decodePersistedComposerDrafts,
  type ComposerDraft,
  getComposerDraftSnapshot,
  removeComposerDraftsForEnvironment,
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
        ...draft,
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

  it("fails closed when persisted drafts cannot be loaded for destructive cleanup", async () => {
    const loadError = new Error("draft file unavailable");
    let writes = 0;

    await expect(
      clearComposerDraftsEnvironmentState({
        environmentId: EnvironmentId.make("environment-cloud"),
        current: () => ({}),
        load: async () => {
          throw loadError;
        },
        write: async () => {
          writes += 1;
        },
        commit: () => undefined,
      }),
    ).rejects.toBe(loadError);
    expect(writes).toBe(0);
  });

  it("preserves persisted drafts from other environments during cleanup", async () => {
    const environmentId = EnvironmentId.make("environment-cloud");
    const retainedEnvironmentId = EnvironmentId.make("environment-local");
    let written: Record<string, ComposerDraft> | null = null;

    const next = await clearComposerDraftsEnvironmentState({
      environmentId,
      current: () => ({
        [`${environmentId}:thread-cloud`]: DRAFT,
      }),
      load: async () => ({
        [`${retainedEnvironmentId}:thread-local`]: DRAFT,
      }),
      write: async (drafts) => {
        written = drafts;
      },
      commit: () => undefined,
    });

    expect(next).toEqual({
      [`${retainedEnvironmentId}:thread-local`]: DRAFT,
    });
    expect(written).toEqual(next);
  });

  it("serializes concurrent environment cleanup transactions", async () => {
    const firstEnvironmentId = EnvironmentId.make("environment-first");
    const secondEnvironmentId = EnvironmentId.make("environment-second");
    const retainedEnvironmentId = EnvironmentId.make("environment-retained");
    let drafts = {
      [`${firstEnvironmentId}:thread-first`]: DRAFT,
      [`${secondEnvironmentId}:thread-second`]: DRAFT,
      [`${retainedEnvironmentId}:thread-retained`]: DRAFT,
    };
    const cleanup = (environmentId: EnvironmentId) =>
      clearComposerDraftsEnvironmentState({
        environmentId,
        current: () => drafts,
        load: async () => drafts,
        write: async (next) => {
          await Promise.resolve();
          drafts = next;
        },
        commit: (next) => {
          drafts = next;
        },
      });

    await Promise.all([cleanup(firstEnvironmentId), cleanup(secondEnvironmentId)]);

    expect(drafts).toEqual({
      [`${retainedEnvironmentId}:thread-retained`]: DRAFT,
    });
  });
});
