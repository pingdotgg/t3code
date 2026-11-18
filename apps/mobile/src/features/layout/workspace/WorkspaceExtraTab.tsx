import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";
import { useWorkspacePhoneBar } from "./useWorkspacePhoneBar";
import { WorkspacePhoneBar } from "./WorkspacePhoneBar";

export function WorkspaceExtraTab(_props: { tab: Extract<NavigationTab, "usage"> }) {
  // Conn: iPhones switch tabs from WorkspacePhoneBar, so Usage shows it too.
  const connPhoneBar = useWorkspacePhoneBar();
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      <UsageRouteScreen workspace />
      {connPhoneBar ? <WorkspacePhoneBar /> : null}
    </>
  );
}
