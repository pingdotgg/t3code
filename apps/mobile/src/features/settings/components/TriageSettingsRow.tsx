import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import * as Dialog from "../../../components/ui/Dialog";
import { useThreadShells } from "../../../state/entities";
import { projectEnvironment } from "../../../state/projects";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../../state/use-composer-drafts";
import {
  latestThreadEnvironmentIds,
  promptLinkScratchEnvironmentId,
} from "../../prompt-links/prompt-link-model";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";
import { SettingsRow } from "./SettingsRow";

export function TriageSettingsRow() {
  const navigation = useNavigation();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const threads = useThreadShells();
  const prepareTriage = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const [pending, setPending] = useState(false);

  const environmentId = promptLinkScratchEnvironmentId(
    latestThreadEnvironmentIds(threads),
    selectedTargets
      .filter(
        (target) =>
          target.serverConfig.environment.capabilities.triage === true &&
          availableScratchWorkspaceRoot(target.connection.phase, target.serverConfig) !== null,
      )
      .map((target) => target.environmentId),
  );
  const allowed = useAtomValue(serverEnvironment.prepareTriage.permissionAtom(environmentId));
  if (environmentId === null) return null;

  const fail = (error: unknown) =>
    Dialog.alert(
      "Could not start triage",
      error instanceof Error ? error.message : "Something went wrong.",
    );

  const start = async () => {
    const prepared = await prepareTriage({ environmentId, input: {} });
    if (prepared._tag === "Failure") {
      if (!isAtomCommandInterrupted(prepared)) fail(squashAtomCommandFailure(prepared));
      return;
    }
    const project = await openScratch({ environmentId, input: {} });
    if (project._tag === "Failure") {
      if (!isAtomCommandInterrupted(project)) fail(squashAtomCommandFailure(project));
      return;
    }
    await waitForComposerDraftsLoaded();
    const draftId = createNewTaskDraft({
      environmentId: project.value.environmentId,
      projectId: project.value.id,
    });
    setComposerDraftText(draftId, prepared.value.prompt);
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: { draftId, title: project.value.title },
    });
  };

  return (
    <SettingsRow
      icon="ladybug"
      label="Triage an issue"
      disabled={!allowed || pending}
      onPress={() => {
        setPending(true);
        void start()
          .catch(fail)
          .finally(() => setPending(false));
      }}
    />
  );
}
