import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

import { translateDynamic } from "../../i18nCore";

export function offHeadPullRequestCheckoutToast(terminology: ChangeRequestTerminology) {
  return {
    type: "warning",
    title: translateDynamic("pullRequest:checkoutToast.notConfirmedTitle"),
    description: translateDynamic("pullRequest:checkoutToast.notConfirmedDetail", {
      term: terminology.singular,
    }),
  } as const;
}
