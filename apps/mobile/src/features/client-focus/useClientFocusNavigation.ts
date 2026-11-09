import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";

import { setMobileClientFocusHandler } from "../../connection/client-focus";
import { appAtomRegistry } from "../../state/atom-registry";
import { agentsBoardSelectionAtom } from "../home/agents-board-state";
import { fileRoutePathSegments } from "../files/filePath";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

/** Shows the Agents board, threads, and files that an agent brings on screen on this device. */
export function useClientFocusNavigation(): void {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the connected environment's focus handler while this navigator is mounted
  useEffect(() => {
    setMobileClientFocusHandler(async (environmentId, request) => {
      const target = request.target;
      if (target._tag === "agents") {
        appAtomRegistry.set(agentsBoardSelectionAtom, { tab: "agents", profileId: null });
        navigation.navigate("Home");
        return;
      }
      const thread = { environmentId: String(environmentId), threadId: String(target.threadId) };
      selectDetail({ name: "Thread", params: thread });
      if (target._tag === "file") {
        navigation.navigate("ThreadFile", {
          ...thread,
          path: fileRoutePathSegments(target.path),
          ...(target.line === undefined ? {} : { line: String(target.line) }),
        });
      }
    });
    return () => setMobileClientFocusHandler(null);
  }, [navigation, selectDetail]);
}
