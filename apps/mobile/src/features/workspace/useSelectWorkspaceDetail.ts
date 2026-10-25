import { useNavigation } from "@react-navigation/native";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import {
  selectWorkspaceDetail,
  type WorkspaceDetail,
  type WorkspaceDetailSheet,
} from "./workspace-detail-selection";

/**
 * Shows a page in the detail column the way selecting its list row does. Inside the workspace
 * layout this also settles its panes; outside it, the root stack's router still does the rest.
 */
export function useSelectWorkspaceDetail() {
  const navigation = useNavigation();
  const { selectDetail } = useAdaptiveWorkspaceLayout();
  return (
    selectDetail ??
    ((detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet) =>
      navigation.dispatch(selectWorkspaceDetail(detail, sheet)))
  );
}
