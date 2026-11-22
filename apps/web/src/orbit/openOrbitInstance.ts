import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { OrbitGatewayEnvironment } from "@t3tools/client-runtime/orbit-gateway";
import type { AnyRouter } from "@tanstack/react-router";

import type { DraftId } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { createNewThreadHandler } from "../hooks/useHandleNewThread";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects } from "../state/entities";
import { carryComposerDraft } from "./carryComposerDraft";
import { openOrbitDraft } from "./openOrbitDraft";
import { orbitWakeSupported } from "./orbitInstanceSleep";
import { orbitThreadStartBlockedReason } from "./orbitThreadStarts";
import {
  buildOrbitInstanceRows,
  orbitCloneProject,
  orbitInstancePick,
  type OrbitInstanceRow,
} from "./orbitInstanceStepLogic";

/** The Project facts an existing Instance's draft needs, from a draft target or a palette row. */
export interface OrbitInstanceDraftProject {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly nodeName: string | null;
  readonly domainSuffix: string | null;
}

/**
 * Opens a thread in an existing Instance, as its row in the Instance step does: a paired one with a
 * loaded project gets a normal draft there, any other one an Orbit draft of kind existing. Null
 * for a row that cannot be picked or a draft that could not open.
 */
async function openOrbitInstanceRow(
  router: AnyRouter,
  project: OrbitInstanceDraftProject,
  row: OrbitInstanceRow,
): Promise<DraftId | null> {
  const pick = orbitInstancePick(row);
  if (pick.kind === "disabled") return null;
  const cloneProject =
    pick.kind === "paired" ? orbitCloneProject(readProjects(), pick.environmentId) : null;
  if (cloneProject !== null) {
    const opened = await createNewThreadHandler(router)(
      scopeProjectRef(cloneProject.environmentId, cloneProject.id),
    );
    return opened?.draftId ?? null;
  }
  // Unpaired, or paired but its project has not loaded yet: the Orbit draft handles both.
  return openOrbitDraft(router, {
    projectId: project.id,
    projectSlug: project.slug,
    projectName: project.name,
    nodeName: row.nodeName ?? project.nodeName ?? "",
    instanceKind: "existing",
    instanceName: row.name,
    existing: { instanceId: row.instanceId, environmentId: row.environmentId },
    domainSuffix: project.domainSuffix,
  });
}

export type OrbitInstanceByIdResult =
  | { readonly kind: "opened"; readonly draftId: DraftId }
  /** The Instance has no T3 server this device can reach, or cannot be picked now. */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Selects the Instance a branch belongs to (the branch menu's "in instance" row, or the card of a
 * create refused with `branch.in_use`), with the same outcome as its row in the Instance step.
 * With `carryDraftFrom`, a different draft that opens receives that draft's prompt, model and modes.
 */
export async function openOrbitInstanceById(input: {
  readonly router: AnyRouter;
  readonly project: OrbitInstanceDraftProject;
  readonly instance: { readonly id: number; readonly name: string };
  readonly environments: () => Promise<readonly OrbitGatewayEnvironment[]>;
  readonly carryDraftFrom?: DraftId | undefined;
}): Promise<OrbitInstanceByIdResult> {
  const environments = await input.environments();
  const row = buildOrbitInstanceRows({
    projectId: input.project.id,
    environments,
    threads: [],
    pairedEnvironmentIds: new Set(
      appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.keys(),
    ),
    canWake: orbitWakeSupported(),
  }).find((entry) => entry.instanceId === input.instance.id);
  if (row === undefined) {
    return {
      kind: "unavailable",
      reason: `Instance ${input.instance.name} has no Conn Server this device can reach.`,
    };
  }
  if (row.disabledReason !== null) {
    return { kind: "unavailable", reason: `Instance ${row.name}: ${row.disabledReason}` };
  }
  const draftId = await openOrbitInstanceRow(input.router, input.project, row);
  if (draftId !== null && input.carryDraftFrom !== undefined) {
    carryComposerDraft(input.carryDraftFrom, draftId);
  }
  return draftId !== null
    ? { kind: "opened", draftId }
    : {
        kind: "unavailable",
        reason:
          orbitThreadStartBlockedReason() ??
          `Conn could not open Instance ${row.name} here. Pick it again in the palette.`,
      };
}
