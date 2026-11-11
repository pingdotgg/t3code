import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ScopedThreadRef,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { newThreadId } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { threadEnvironment } from "../../state/threads";
import {
  COORDINATOR_THREAD_TAG,
  COORDINATOR_THREAD_TITLE,
  resolveCoordinatorModelSelection,
} from "./projectCoordinator.logic";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Returns the project's coordinator, creating and tagging one in the project root when it has
 * none, and opens the project threads tab in its right panel.
 */
export async function ensureProjectCoordinator(input: {
  readonly project: EnvironmentProject;
  readonly existing: EnvironmentThreadShell | null;
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
}): Promise<ScopedThreadRef> {
  const { project } = input;
  let ref: ScopedThreadRef;
  if (input.existing !== null) {
    ref = scopeThreadRef(project.environmentId, input.existing.id);
  } else {
    const modelSelection = resolveCoordinatorModelSelection({
      settings: input.settings,
      providers: input.providers,
      projectId: project.id,
      now: Date.now(),
    });
    if (modelSelection === null) {
      throw new Error("No provider is available for this project. Set one up in Settings.");
    }
    const threadId = newThreadId();
    const created = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.create,
      {
        environmentId: project.environmentId,
        input: {
          threadId,
          projectId: project.id,
          title: COORDINATOR_THREAD_TITLE,
          modelSelection,
          runtimeMode: resolveProjectSettings(input.settings, project.id, project).settings
            .defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
        },
      },
      { label: "Create coordinator", reportFailure: false },
    );
    if (created._tag === "Failure") throw new Error(failureMessage(created));
    // A failed tag leaves an ordinary thread; the next open retries on a fresh coordinator.
    const tagged = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.setTag,
      {
        environmentId: project.environmentId,
        input: { threadId, tag: COORDINATOR_THREAD_TAG, tagged: true },
      },
      { label: "Mark coordinator", reportFailure: false },
    );
    if (tagged._tag === "Failure") throw new Error(failureMessage(tagged));
    ref = scopeThreadRef(project.environmentId, threadId);
  }
  useRightPanelStore.getState().openProjectThreads(ref);
  return ref;
}
