import { useNavigation } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";

import * as Dialog from "../../components/ui/Dialog";
import { authClientMetadata } from "../../lib/authClientMetadata";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";

const CLI_COMMAND = "npx t3 triage";

/**
 * In-app `t3 triage`, as on web: the server writes the session files and
 * clones the matching source, then a No project draft opens with the prompt.
 */
export function useStartTriage() {
  const navigation = useNavigation();
  const prepare = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });

  const fail = (message: string) =>
    Dialog.alert(
      "Could not start triage",
      `${message} Run ${CLI_COMMAND} in a terminal on that machine instead.`,
      [
        { text: "Copy command", onPress: () => void Clipboard.setStringAsync(CLI_COMMAND) },
        { text: "OK", style: "cancel" },
      ],
    );
  const errorMessage = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback;

  return async (environmentId: EnvironmentId) => {
    const prepared = await prepare({
      environmentId,
      input: { client: authClientMetadata(Constants.expoConfig?.version) },
    });
    if (prepared._tag === "Failure") {
      if (!isAtomCommandInterrupted(prepared)) {
        fail(errorMessage(squashAtomCommandFailure(prepared), "The server could not prepare it."));
      }
      return;
    }
    const scratch = await openScratch({ environmentId, input: {} });
    if (scratch._tag === "Failure") {
      if (!isAtomCommandInterrupted(scratch)) {
        fail(
          errorMessage(squashAtomCommandFailure(scratch), "No project threads are not available."),
        );
      }
      return;
    }
    try {
      await waitForComposerDraftsLoaded();
    } catch {
      fail("Drafts could not be loaded.");
      return;
    }
    const draftId = createNewTaskDraft({
      environmentId,
      projectId: scratch.value.id,
    });
    setComposerDraftText(draftId, prepared.value.prompt);
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: { draftId, title: "Triage" },
    });
  };
}
