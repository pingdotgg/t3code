import { requestConfirmDialog } from "../confirmDialog";
import { readThreadShells } from "../state/entities";
import {
  describeCheckoutSwitchImpact,
  resolveThreadsMovedByCheckoutSwitch,
} from "./BranchToolbar.logic";

/** Asks before a ref switch moves other open threads that share the checkout. */
export async function confirmCheckoutSwitch(
  input: Omit<Parameters<typeof resolveThreadsMovedByCheckoutSwitch>[0], "threads">,
): Promise<boolean> {
  const titles = resolveThreadsMovedByCheckoutSwitch({ ...input, threads: readThreadShells() });
  if (titles.length === 0 || input.currentBranch === null) return true;
  const message = describeCheckoutSwitchImpact({
    titles,
    currentBranch: input.currentBranch,
    nextBranch: input.nextBranch,
  });
  return (await requestConfirmDialog(message)) ?? window.confirm(message);
}
