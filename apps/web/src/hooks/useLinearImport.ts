import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { formatLinearIssues, type LinearImportMode } from "../lib/linearFormat";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useProjects } from "../state/entities";
import { linearEnvironment } from "../state/linear";
import { useAtomCommand } from "../state/use-atom-command";
import { useClientSettings } from "./useSettings";
import { useNewThreadHandler } from "./useHandleNewThread";

export interface LinearImportTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface LinearImportResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Imports the selected Linear issues into a fresh draft thread for `target`
 * and pre-fills the composer with the formatted issue context. The user then
 * reviews and sends, which promotes the draft to a real thread.
 */
export function useLinearImport() {
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const newThread = useNewThreadHandler();
  const fetchIssues = useAtomCommand(linearEnvironment.fetchIssues, "linear fetch issues");

  return useCallback(
    async (input: {
      readonly target: LinearImportTarget;
      readonly ids: ReadonlyArray<string>;
      readonly mode: LinearImportMode;
    }): Promise<LinearImportResult> => {
      if (input.ids.length === 0) {
        return { ok: false, error: "Select at least one issue to import." };
      }

      const projectRef = scopeProjectRef(input.target.environmentId, input.target.projectId);
      const result = await fetchIssues({
        environmentId: input.target.environmentId,
        input: { ids: [...input.ids] },
      });
      if (result._tag !== "Success") {
        return { ok: false, error: "Failed to load the selected Linear issues." };
      }
      const issues = result.value.issues;
      if (issues.length === 0) {
        return { ok: false, error: "The selected issues could not be loaded." };
      }

      const markdown = formatLinearIssues(issues, input.mode);
      await newThread(projectRef);

      const project = projects.find(
        (candidate) =>
          candidate.id === input.target.projectId &&
          candidate.environmentId === input.target.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, groupingSettings)
        : scopedProjectKey(projectRef);
      const draft = useComposerDraftStore
        .getState()
        .getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (draft) {
        useComposerDraftStore.getState().setPrompt(draft.draftId, markdown);
      }
      return { ok: true };
    },
    [fetchIssues, groupingSettings, newThread, projects],
  );
}
