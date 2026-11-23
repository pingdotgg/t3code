import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { MemoryScreen } from "../../kompas/MemoryScreen";
import { StudyScreen } from "../../kompas/StudyScreens";
import { WorkstreamsScreen } from "../../kompas/WorkstreamScreens";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";
import { WorkflowsScreen } from "../../workflows/WorkflowsScreen";
import type { PageTab } from "./workspace-tabs-state";

function page(tab: PageTab) {
  switch (tab) {
    case "workflows":
      return <WorkflowsScreen />;
    case "workstreams":
      return <WorkstreamsScreen />;
    case "study":
      return <StudyScreen />;
    case "memory":
      return <MemoryScreen />;
    case "usage":
      return <UsageRouteScreen workspace />;
  }
}

export function WorkspaceExtraTab(props: { tab: PageTab }) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {page(props.tab)}
    </>
  );
}
