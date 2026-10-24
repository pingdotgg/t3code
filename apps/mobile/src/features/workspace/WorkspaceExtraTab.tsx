import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { UsageRouteScreen } from "../usage/UsageRouteScreen";

export function WorkspaceExtraTab(_props: {
  tab: Exclude<NavigationTab, "threads" | "pullRequests">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      <UsageRouteScreen workspace />
    </>
  );
}
