import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { pipe } from "effect/Function";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useGT } from "gt-react-native";
import { m } from "../../i18n/messages";

import * as Dialog from "../../components/ui/Dialog";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { usePrepareTriage } from "./usePrepareTriage";

const CLI_COMMAND = "ada triage";

/**
 * In-app `ada triage`, as on web: the server writes the session files and
 * clones the matching source, then a No project draft opens with the prompt.
 */
export function useStartTriage() {
  const navigation = useNavigation();
  const gt = useGT();
  const selectDetail = useSelectWorkspaceDetail();
  const prepare = usePrepareTriage();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });

  const fail = (message: string) =>
    Dialog.alert(
      gt("Could not start triage"),
      gt("{message} Run {command} in a terminal on that machine instead.", {
        message,
        command: CLI_COMMAND,
      }),
      [
        {
          text: gt("Copy command"),
          onPress: () =>
            void Clipboard.setStringAsync(CLI_COMMAND).catch(() =>
              Dialog.alert(
                gt("Could not copy"),
                gt("Type {command} instead.", { command: CLI_COMMAND }),
              ),
            ),
        },
        { text: gt("OK"), style: "cancel" },
      ],
    );
  const errorMessage = (error: unknown, fallback: string) =>
    error instanceof Error ? (errorDisplayMessage(error, m) ?? error.message) : fallback;

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
        pipe(
          squashAtomCommandFailure(scratch),
          (failure) =>
            errorMessage(failure, gt("This machine cannot start threads without a project.")),
          fail,
        );
      }
      return;
    }
    const prepared = await prepare(environmentId);
    if (prepared._tag === "Failure") {
      if (!isAtomCommandInterrupted(prepared)) {
        pipe(
          squashAtomCommandFailure(prepared),
          (failure) => errorMessage(failure, gt("The server could not prepare it.")),
          fail,
        );
      }
      return;
    }
    try {
      await waitForComposerDraftsLoaded();
    } catch {
      fail(gt("Drafts could not be loaded."));
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
      params: {
        draft: {
          environmentId,
          projectId: scratch.value.id,
          title: gt("Triage", { $context: "draft thread title" }),
          draftId,
        },
      },
    });
  };
}
