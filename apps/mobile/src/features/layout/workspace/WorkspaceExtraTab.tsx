import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";
import { WorkflowsScreen } from "../../workflows/WorkflowsScreen";

export function WorkspaceExtraTab(props: { tab: Extract<NavigationTab, "usage" | "workflows"> }) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "workflows" ? <WorkflowsScreen /> : <UsageRouteScreen workspace />}
    </>
  );
}
