import { useAtomValue } from "@effect/atom-react";
import type { LinearLaunchActions } from "@t3tools/client-runtime/linear/launch-plan";
import { StackActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { startLinearChatDraft } from "./linearChatDraft";

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

/**
 * Opens a thread from a Linear page the way pull request pages do: Android shows one page at a
 * time; iOS pushes it over the issue, so Back returns there.
 */
export function useOpenLinearThread() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  return (destination: ReactNavigation.RootParamList["Thread"]) => {
    if (Platform.OS === "android") selectDetail({ name: "Thread", params: destination });
    else navigation.dispatch(StackActions.push("Thread", destination));
  };
}

/**
 * Launch flows from an issue in `environmentId` (the route's): a chat in the new-task draft, or a
 * pipeline run from the sheet. `canRunPipeline` is false without the pipelines capability.
 */
export function useLinearLaunch(environmentId: EnvironmentId): LinearLaunchActions & {
  readonly canRunPipeline: boolean;
  readonly startingChat: boolean;
} {
  const navigation = useNavigation();
  const openThread = useOpenLinearThread();
  const serverConfigs = useServerConfigs();
  const canStartPipelines = useAtomValue(
    serverEnvironment.startPipelineRun.permissionAtom(environmentId),
  );
  const canRunPipeline =
    canStartPipelines &&
    serverConfigs.get(environmentId)?.environment.capabilities.pipelines === true;
  // A second tap while the issue loads would create a second draft.
  const startingRef = useRef(false);
  const [startingChat, setStartingChat] = useState(false);

  return {
    canRunPipeline,
    startingChat,
    startChat: (issueId, options) => {
      if (startingRef.current) return;
      startingRef.current = true;
      setStartingChat(true);
      void startLinearChatDraft({
        environmentId,
        issueId,
        workspace: options?.workspace,
        projectId: undefined,
      })
        .then((started) => {
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
            openThread(
              linearDraftRoute({
                environmentId,
                projectId: started.projectId,
                draftKey: started.draftKey,
                identifier: started.identifier,
              }),
            );
          }
        })
        .finally(() => {
          startingRef.current = false;
          setStartingChat(false);
        });
    },
    openPipeline: (issueId, pipelineId) => {
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
