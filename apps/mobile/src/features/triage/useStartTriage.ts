import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
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
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

const CLI_COMMAND = "npx t3 triage";

/**
 * In-app `t3 triage`, as on web: the server writes the session files and
 * clones the matching source, then a No project draft opens with the prompt.
 */
export function useStartTriage() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const prepare = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });

  const fail = (message: string) =>
    Dialog.alert(
      "Could not start triage",
      `${message} Run ${CLI_COMMAND} in a terminal on that machine instead.`,
      [
        {
          text: "Copy command",
          onPress: () =>
            void Clipboard.setStringAsync(CLI_COMMAND).catch(() =>
              Dialog.alert("Could not copy", `Type ${CLI_COMMAND} instead.`),
            ),
        },
        { text: "OK", style: "cancel" },
      ],
    );
  const errorMessage = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback;

  const activeRoute = () => {
    const state = navigation.getState();
    return state?.routes[state.index];
  };

  return async (environmentId: EnvironmentId) => {
    // If the user goes elsewhere while this waits, the draft stays closed
    // instead of pulling them away. Split view changes params, not the route.
    const startRoute = activeRoute();
    const routeChanged = () => {
      const route = activeRoute();
      if (route === startRoute) return false;
      if (route === undefined || startRoute === undefined) return true;
      return route.key !== startRoute.key || route.params !== startRoute.params;
    };
    const scratch = await openScratch({ environmentId, input: {} });
    if (scratch._tag === "Failure") {
      if (!isAtomCommandInterrupted(scratch)) {
        fail(
          errorMessage(
            squashAtomCommandFailure(scratch),
            "This machine cannot start threads without a project.",
          ),
        );
      }
      return;
    }
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
    try {
      await waitForComposerDraftsLoaded();
    } catch {
      fail("Drafts could not be loaded.");
      return;
    }
    if (routeChanged()) return;
    const draftId = createNewTaskDraft({
      environmentId,
      projectId: scratch.value.id,
    });
    setComposerDraftText(draftId, prepared.value.prompt);
    selectDetail({
      name: "Thread",
      params: { draft: { environmentId, projectId: scratch.value.id, title: "Triage", draftId } },
    });
  };
}
