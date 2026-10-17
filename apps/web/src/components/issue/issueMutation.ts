import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { toastManager } from "../ui/toast";

export function reportIssueResult<A, E>(
  result: AtomCommandResult<A, E>,
  title: string,
  fallback = "The tracker refused it. Check your access to this issue.",
): result is Extract<AtomCommandResult<A, E>, { readonly _tag: "Success" }> {
  if (result._tag === "Success") return true;
  toastManager.add({
    type: "error",
    title,
    description: readableFailure(squashAtomCommandFailure(result), fallback),
  });
  return false;
}
