import { useAtomMount } from "@effect/atom-react";

import { linearStatusAtom } from "../../state/linear";

// Link handlers read Linear status at press time, so keep it loaded even when no thread list or
// Linear screen is mounted (a thread opened from a notification).
export function LinearStatusKeepAlive() {
  useAtomMount(linearStatusAtom);
  return null;
}
