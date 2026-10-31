import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { startLinearChatDraft } from "./linearChatDraft";
import type { LinearLaunchActions } from "./linearLaunchActions";
import { useLinearEnvironmentId } from "./useLinearData";

/** The thread route params for a started draft. */
export function linearDraftRoute(draft: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly draftKey: string;
  readonly identifier: string;
}) {
  return {
    draft: {
      environmentId: draft.environmentId,
      projectId: draft.projectId,
      draftId: draft.draftKey,
      title: draft.identifier,
    },
  };
}

/** Launch flows from an issue: a chat in the new-task draft, or a pipeline run from the sheet. */
export function useLinearLaunch(): LinearLaunchActions {
  const navigation = useNavigation();
  const environmentId = useLinearEnvironmentId();
  const selectDetail = useSelectWorkspaceDetail();
  const serverConfigs = useServerConfigs();
  const canStartPipelines = useAtomValue(
    serverEnvironment.startPipelineRun.permissionAtom(environmentId),
  );
  const canRunPipeline =
    environmentId !== null &&
    canStartPipelines &&
    serverConfigs.get(environmentId)?.environment.capabilities.pipelines === true;

  return {
    canRunPipeline,
    startChat: (issueId, options) => {
      if (environmentId === null) return;
      void startLinearChatDraft({
        environmentId,
        issueId,
        workspace: options?.workspace,
        projectId: undefined,
      }).then((started) => {
        if (started.kind === "needs-project") {
          navigation.dispatch(
            StackActions.push("LinearProjectPicker", {
              environmentId,
              issueId,
              ...(options?.workspace ? { workspace: options.workspace } : {}),
            }),
          );
        } else if (started.kind === "failed") {
          Dialog.alert("Could not start a chat", started.message);
        } else {
          const destination = linearDraftRoute({
            environmentId,
            projectId: started.projectId,
            draftKey: started.draftKey,
            identifier: started.identifier,
          });
          // Android shows one page at a time; iOS opens the draft over the issue, so Back returns.
          if (Platform.OS === "android") selectDetail({ name: "Thread", params: destination });
          else navigation.dispatch(StackActions.push("Thread", destination));
        }
      });
    },
    openPipelineSheet: (issueId, pipelineId) => {
      if (environmentId === null) return;
      navigation.dispatch(
        StackActions.push("LinearPipeline", {
          environmentId,
          issueId,
          ...(pipelineId ? { pipelineId } : {}),
        }),
      );
    },
  };
}
