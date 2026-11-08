import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { scheduledTaskBaseRefAtom } from "../../state/vcs";

export function useScheduledTaskBaseRef(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly chosen: string;
  readonly worktree: boolean;
}) {
  const autoBaseRef = useAtomValue(
    scheduledTaskBaseRefAtom({
      environmentId: input.environmentId,
      cwd: input.worktree && !input.chosen ? input.cwd : null,
    }),
  );
  return { baseRef: input.chosen || autoBaseRef.baseRef, pending: autoBaseRef.pending };
}
