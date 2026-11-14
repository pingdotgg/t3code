import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { AnyRouter } from "@tanstack/react-router";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { newDraftId, newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { hostEnvironmentIdAtom, primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { useEnvironmentProvider } from "./environmentProvider";
import {
  chooseOrbitDraftAnchor,
  orbitDraftLogicalProjectKey,
  orbitDraftProjectId,
  type OrbitDraftTarget,
} from "./orbitDraft";
import { orbitThreadStartBlockedReason } from "./orbitThreadStarts";

/**
 * Opens the draft for a thread in a new Instance or an unpaired one; a paired Instance uses a normal
 * draft in its `/srv/workspace` project. Reopening a Project keeps its draft and swaps the target.
 * Null only where `orbitThreadStartBlockedReason` names why: outside the desktop app or Orbit mode.
 */
export async function openOrbitDraft(
  router: AnyRouter,
  target: OrbitDraftTarget,
): Promise<DraftId | null> {
  if (orbitThreadStartBlockedReason() !== null) return null;
  const anchor = chooseOrbitDraftAnchor({
    orbitProjectId: target.projectId,
    orbitInstances: useEnvironmentProvider.getState().orbitInstances,
    savedEnvironments: appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries,
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    hostEnvironmentId: appAtomRegistry.get(hostEnvironmentIdAtom),
  });
  const logicalProjectKey = orbitDraftLogicalProjectKey(target.projectId);
  const store = useComposerDraftStore.getState();
  const existing = store.getDraftSessionByLogicalProjectKey(logicalProjectKey);
  const draftId = existing?.draftId ?? newDraftId();
  // A new Instance keeps the branch chosen for the Project's draft unless the target sets one.
  const previous = existing?.orbitTarget;
  const keptBranch =
    target.instanceKind === "new" &&
    target.branch === undefined &&
    previous?.projectId === target.projectId
      ? {
          ...(previous.branch ? { branch: previous.branch } : {}),
          ...(previous.defaultBranch ? { defaultBranch: previous.defaultBranch } : {}),
        }
      : {};
  store.setLogicalProjectDraftThreadId(
    logicalProjectKey,
    scopeProjectRef(anchor, orbitDraftProjectId(target.projectId)),
    draftId,
    {
      threadId: existing?.threadId ?? newThreadId(),
      envMode: "local",
      branch: null,
      worktreePath: null,
      orbitTarget: { ...target, ...keptBranch },
    },
  );
  await router.navigate({ to: "/draft/$draftId", params: { draftId } });
  return draftId;
}
