import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { botCrewBoard, groupBots } from "@t3tools/client-runtime/state/thread-grouping";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadShells } from "~/state/entities";

export function useBotBoard(threadRef: ScopedThreadRef) {
  return botCrewBoard(groupBots(useQuietThreadShells()), scopedThreadKey(threadRef));
}
