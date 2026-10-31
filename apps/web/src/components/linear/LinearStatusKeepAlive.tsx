import { useAtomMount } from "@effect/atom-react";

import { linearStatusAtom } from "../../state/linear";

// Link handlers read Linear status at click time, so something must keep it loaded even when the
// sidebar rows that otherwise mount it are off-screen (narrow layouts).
export function LinearStatusKeepAlive() {
  useAtomMount(linearStatusAtom);
  return null;
}
