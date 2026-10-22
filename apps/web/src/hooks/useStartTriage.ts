import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, TRIAGE_PROMPT_FILE_NAME } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { currentClientMetadata } from "~/connection/platform";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

export const TRIAGE_CLI_COMMAND = "npx t3 triage";

const copyTriageCliCommand = () => writeTextToClipboard(TRIAGE_CLI_COMMAND, "command");

/** A draft is a triage draft while its message still links the playbook file. */
export const isTriagePrompt = (prompt: string) => prompt.includes(`[${TRIAGE_PROMPT_FILE_NAME}](`);

/**
 * In-app `t3 triage`: the server writes the session files and starts cloning
 * the matching source, then a No project draft opens with the playbook linked.
 * The draft hero explains the rest; the user picks a provider and describes
 * the problem.
 */
export function useStartTriage() {
  const { scratchWorkspaceRootFor } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const prepare = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });

  // With no draft to show, a toast is the only place to point at the CLI.
  const fail = (description: string) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not start triage",
        description: `${description} Run ${TRIAGE_CLI_COMMAND} in a terminal instead.`,
        timeout: 0,
        actionProps: { children: "Copy command", onClick: () => void copyTriageCliCommand() },
      }),
    );
  const failWith = (
    result: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
  ) => {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    fail(error instanceof Error ? error.message : "An error occurred.");
  };

  return async (environmentId: EnvironmentId) => {
    if (scratchWorkspaceRootFor(environmentId) === null) {
      fail("This environment cannot start threads without a project.");
      return;
    }
    const prepared = await prepare({
      environmentId,
      input: { client: currentClientMetadata() },
    });
    if (prepared._tag === "Failure") return failWith(prepared);
    const project = await openScratch({ environmentId, input: {} });
    if (project._tag === "Failure") return failWith(project);
    const opened = await handleNewThread(
      scopeProjectRef(project.value.environmentId, project.value.id),
    ).catch(() => null);
    if (opened === null) {
      fail("T3 Code could not open a new thread.");
      return;
    }
    useComposerDraftStore.getState().setPrompt(opened.draftId, prepared.value.prompt);
  };
}
