import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { formatLinearIssues, type LinearImportMode } from "@t3tools/client-runtime/linear-format";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { linearEnvironment } from "../state/linear";
import { useAtomCommand } from "../state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

export interface LinearImportTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface LinearImportResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly warning?: string;
}

export function useLinearImport() {
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

      const created = await newThread(
        scopeProjectRef(input.target.environmentId, input.target.projectId),
      );
      if (created === null) {
        return { ok: false, error: "Could not create a draft thread for the import." };
      }

      useComposerDraftStore
        .getState()
        .setPrompt(created.draftId, formatLinearIssues(issues, input.mode));

      const returnedIds = new Set(issues.map((issue) => issue.id));
      const missingCount = input.ids.filter((id) => !returnedIds.has(id)).length;
      if (missingCount > 0) {
        return {
          ok: true,
          warning: `Imported ${issues.length} of ${input.ids.length} issues. ${missingCount} couldn't be loaded.`,
        };
      }
      return { ok: true };
    },
    [fetchIssues, newThread],
  );
}
