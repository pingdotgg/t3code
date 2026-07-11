import type { VcsRef } from "@t3tools/contracts";

import { resolveMainCheckoutTarget } from "../components/BranchToolbar.logic";

export interface MainCheckoutTarget {
  readonly branch: string;
  readonly path: string | null;
}

interface RefSnapshot {
  readonly refs: readonly VcsRef[];
  readonly mainCheckoutPath?: string | null | undefined;
}

export async function resolveProjectMainCheckout(input: {
  readonly isActiveProject: boolean;
  readonly activeRefsLoaded: boolean;
  readonly activeProjectMainCheckout: MainCheckoutTarget | null | undefined;
  readonly projectWorkspaceRoot: string;
  readonly loadRefs: () => Promise<RefSnapshot | null>;
}): Promise<MainCheckoutTarget | undefined> {
  if (input.isActiveProject && input.activeRefsLoaded) {
    return input.activeProjectMainCheckout ?? undefined;
  }

  const snapshot = await input.loadRefs();
  if (snapshot === null) return undefined;
  return (
    resolveMainCheckoutTarget(
      snapshot.refs,
      input.projectWorkspaceRoot,
      snapshot.mainCheckoutPath,
    ) ?? undefined
  );
}
