import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { threadHandoverSourceKey } from "@t3tools/shared/threadReference";

/**
 * Stable receipt for importing one source thread's handover into its project
 * draft. The receipt is persisted with the draft, so retries remain idempotent
 * after navigation, module reload, or an app restart.
 */
export function threadHandoverDraftImportId(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string {
  return threadHandoverSourceKey(environmentId, threadId);
}

import { appAtomRegistry } from "./atom-registry";
import {
  composerDraftsAtom,
  createNewTaskDraft,
  mergeComposerDraftContent,
  waitForComposerDraftsLoaded,
  type ComposerDraftWorkspaceSelection,
} from "./use-composer-drafts";

/** Reopens the receipt-bearing draft after restart, or creates a new project-stamped draft. */
export async function prepareThreadHandoverDraft(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  importId: string;
  handover: string;
  workspaceSelection: ComposerDraftWorkspaceSelection;
}): Promise<string> {
  await waitForComposerDraftsLoaded();
  const existing = Object.entries(appAtomRegistry.get(composerDraftsAtom)).find(
    ([, draft]) =>
      draft.project?.environmentId === input.environmentId &&
      draft.project.projectId === input.projectId &&
      draft.importedShareIds?.includes(input.importId),
  );
  const key = existing?.[0] ?? createNewTaskDraft(input);
  await mergeComposerDraftContent(
    key,
    { text: input.handover, attachments: [], sourceShareId: input.importId },
    { workspaceSelection: input.workspaceSelection },
  );
  return key;
}
