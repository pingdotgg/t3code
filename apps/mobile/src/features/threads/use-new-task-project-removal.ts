import { StackActions, useNavigation } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { projectEnvironment } from "../../state/projects";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import * as Dialog from "../../components/ui/Dialog";

/** Clone cancellation/retry and removing a cloned project from the new-task draft. */
export function useNewTaskProjectRemoval(input: {
  readonly selectedProject: EnvironmentProject | null;
  readonly getSelectedProjectKey: () => string | null;
}) {
  const navigation = useNavigation();
  const cancelProjectClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryProjectClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const runCloneAction = async (
    title: string,
    action: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>,
  ) => {
    const result = await action();
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      Dialog.alert(title, error instanceof Error ? error.message : "An error occurred.");
    }
  };
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const removeClonedProject = async () => {
    if (!input.selectedProject) return;
    const removed = input.selectedProject;
    const result = await deleteProject({
      environmentId: removed.environmentId,
      input: { projectId: removed.id },
    });
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Failed to remove project",
        error instanceof Error ? error.message : "An error occurred.",
      );
      return;
    }
    if (input.getSelectedProjectKey() === scopedProjectKey(removed.environmentId, removed.id)) {
      navigation.dispatch(StackActions.replace("Home"));
    }
  };
  return { cancelProjectClone, retryProjectClone, runCloneAction, removeClonedProject };
}
