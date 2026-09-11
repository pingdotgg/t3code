import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clearComposerDraftContentState,
  mergeComposerDraftContentState,
} from "./use-composer-drafts";
import { threadHandoverDraftImportId } from "./threadHandoverDraft";

describe("threadHandoverDraftImportId", () => {
  it("keeps retries idempotent across restart and allows another import after clear", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const destinationDraftKey = "new-task:environment-1:project-1";
    const firstImportId = threadHandoverDraftImportId(environmentId, threadId);
    const written = mergeComposerDraftContentState({}, destinationDraftKey, {
      text: "Generated handover",
      attachments: [],
      sourceShareId: firstImportId,
    });
    const edited = {
      [destinationDraftKey]: {
        ...written[destinationDraftKey]!,
        text: "Edited generated handover",
        workspaceSelection: {
          mode: "worktree" as const,
          branch: "user-edited",
          worktreePath: "/worktrees/edited",
        },
      },
    };

    // A restarted process reconstructs the same receipt from the source
    // thread. Regeneration cannot append over the user's edited draft.
    const restartedImportId = threadHandoverDraftImportId(environmentId, threadId);
    expect(restartedImportId).toBe(firstImportId);
    expect(
      mergeComposerDraftContentState(edited, destinationDraftKey, {
        text: "Regenerated handover",
        attachments: [],
        sourceShareId: restartedImportId,
      }),
    ).toBe(edited);
    expect(edited[destinationDraftKey]?.workspaceSelection?.branch).toBe("user-edited");

    // Clear/send removes import receipts, making the same source eligible for
    // a deliberate new handover draft.
    const cleared = clearComposerDraftContentState(edited, destinationDraftKey);
    const retried = mergeComposerDraftContentState(cleared, destinationDraftKey, {
      text: "Regenerated handover",
      attachments: [],
      sourceShareId: restartedImportId,
    });
    expect(retried[destinationDraftKey]).toMatchObject({
      text: "Regenerated handover",
      importedShareIds: [restartedImportId],
    });
  });

  it("keeps opaque environment and thread IDs unambiguous", () => {
    expect(threadHandoverDraftImportId(EnvironmentId.make("a:b"), ThreadId.make("c"))).not.toBe(
      threadHandoverDraftImportId(EnvironmentId.make("a"), ThreadId.make("b:c")),
    );
  });
});
