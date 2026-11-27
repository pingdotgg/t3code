import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";

import { changeRequestTermKind } from "./changeRequestTerm";

export function offHeadPullRequestCheckoutToast(terminology: ChangeRequestTerminology) {
  return {
    type: "warning",
    title: m(msg("Checked out, but not confirmed on the latest commit")),
    description: m(
      msg(
        "This checkout could not be confirmed at the {term, select, mr {merge request} cr {change request} other {pull request}}'s latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.",
        { term: changeRequestTermKind(terminology) },
      ),
    ),
  } as const;
}
