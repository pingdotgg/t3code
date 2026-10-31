import { useAtomSet } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { View } from "react-native";

import { linearSelectedEnvironmentIdAtom } from "../../state/linear";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import type { LinearRouteParams } from "./linearRoutes";

/** `linear/:environmentId` opens the Linear tab on that environment, replacing this stub route. */
export function LinearWorkspaceLinkScreen({
  route,
}: StaticScreenProps<LinearRouteParams["LinearWorkspace"]>) {
  const selectEnvironment = useAtomSet(linearSelectedEnvironmentIdAtom);
  const selectTab = useSelectWorkspaceTab();
  const { environmentId } = route.params;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a deep link picks the Linear environment and switches the workspace to the Linear tab
  useEffect(() => {
    selectEnvironment(EnvironmentId.make(environmentId));
    selectTab("linear");
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Runs once per link; the tab selector changes identity every render.
  }, [environmentId]);
  return <View className="flex-1 bg-screen" />;
}
