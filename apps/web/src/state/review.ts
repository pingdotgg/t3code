import { createReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/review";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const reviewEnvironment = createReviewEnvironmentAtoms(connectionAtomRuntime);

const workspaceRevisions = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(`review-workspace:${key}`)),
);

export const reviewWorkspaceRevision = (
  environmentId: EnvironmentId | undefined,
  cwd: string | undefined,
) => workspaceRevisions(JSON.stringify([environmentId, cwd]));

/** Confirmed editor saves invalidate previews even while the diff is closed. */
export function invalidateReviewWorkspace(environmentId: EnvironmentId, cwd: string) {
  appAtomRegistry.update(reviewWorkspaceRevision(environmentId, cwd), (revision) => revision + 1);
}
