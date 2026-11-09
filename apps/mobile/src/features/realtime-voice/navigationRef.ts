import type { VoiceOwner } from "@t3tools/client-runtime/realtime-voice";

import { startOpeningDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { rootNavigationRef } from "../../lib/rootNavigation";
import {
  selectWorkspaceDetail,
  type WorkspaceDetail,
} from "../layout/workspace/workspace-detail-selection";

export function returnToVoiceOwner(owner: VoiceOwner): void {
  if (!rootNavigationRef.isReady()) return;
  const detail: WorkspaceDetail = {
    name: "Thread",
    params: { environmentId: owner.environmentId, threadId: owner.threadId },
  };
  startOpeningDetail(detail);
  rootNavigationRef.dispatch(selectWorkspaceDetail(detail));
}
