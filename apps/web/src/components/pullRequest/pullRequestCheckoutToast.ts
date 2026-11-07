import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

import { translateNow } from "../media/translateNow";
export function offHeadPullRequestCheckoutToast(terminology: ChangeRequestTerminology) {
  return {
    type: "warning",
    title: translateNow("review.extra.checked.out.but.not.confirmed.on.the.latest"),
    description: `This checkout could not be confirmed at the ${terminology.singular}'s latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.`,
  } as const;
}
