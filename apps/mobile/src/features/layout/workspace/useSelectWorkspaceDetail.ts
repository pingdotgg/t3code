import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { startOpeningEnvironmentThread } from "../../../state/threads";
import { isBotThread } from "../../../state/bots";
import {
  selectWorkspaceDetail,
  type WorkspaceDetail,
  type WorkspaceDetailSheet,
} from "./workspace-detail-selection";
import { workspaceTabOf } from "./workspace-tabs-state";

const first = (value: string | readonly string[] | undefined) =>
  typeof value === "string" ? value : value?.[0];

/** Starts loading a selected thread before navigation commits; see `startOpeningEnvironmentThread`. */
export function startOpeningDetail(detail: WorkspaceDetail) {
  if (detail.name !== "Thread") return;
  const environmentId = first(detail.params?.environmentId);
  const threadId = first(detail.params?.threadId);
  if (environmentId && threadId) {
    startOpeningEnvironmentThread(EnvironmentId.make(environmentId), ThreadId.make(threadId));
  }
}

/** The tab whose list a detail belongs to: a bot's chat lives under Bots. */
export function workspaceTabForDetail(detail: WorkspaceDetail) {
  if (detail.name !== "Thread") return workspaceTabOf(detail.name);
  const environmentId = first(detail.params?.environmentId);
  const threadId = first(detail.params?.threadId);
  return environmentId && threadId && isBotThread(environmentId, threadId) ? "bots" : "threads";
}

/**
 * Shows a page in the detail column the way selecting its list row does. Inside the workspace
 * layout this also settles its panes; outside it, the root stack's router still does the rest.
 */
export function useSelectWorkspaceDetail() {
  const navigation = useNavigation();
  const { selectDetail } = useAdaptiveWorkspaceLayout();
  return (
    selectDetail ??
    ((detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet) => {
      startOpeningDetail(detail);
      navigation.dispatch(selectWorkspaceDetail(detail, sheet));
    })
  );
}
