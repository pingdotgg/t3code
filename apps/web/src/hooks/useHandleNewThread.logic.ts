import type { VcsRef } from "@t3tools/contracts";

import { deriveWorkspaceOptions } from "../components/BranchToolbar.logic";

interface MainCheckoutTarget {
  readonly branch: string;
  readonly path: string | null;
}

interface RefSnapshot {
  readonly refs: readonly VcsRef[];
  readonly mainCheckoutPath?: string | null;
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
  const options = deriveWorkspaceOptions(
    snapshot.refs,
    input.projectWorkspaceRoot,
    snapshot.mainCheckoutPath,
  );
  if (options.mainCheckout) return options.mainCheckout;
  const defaultRef = snapshot.refs.find((ref) => !ref.isRemote && ref.isDefault);
  return defaultRef ? { branch: defaultRef.name, path: null } : undefined;
}
