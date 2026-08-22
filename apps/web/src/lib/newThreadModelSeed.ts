import type { ModelSelection } from "@t3tools/contracts";

export interface NewThreadDraftModelSeed {
  /**
   * Apply the client-global sticky harness/model first. Only when the
   * destination project has no default — otherwise that default is the seed.
   */
  readonly applySticky: boolean;
  /**
   * Write this onto the draft after sticky (if any). A project default wins
   * over a selection carried from the viewed thread.
   */
  readonly modelSelection: ModelSelection | null;
}

/**
 * Seed a new (or remapped) draft's harness/model.
 *
 * A project-level default is a pin: new threads in that project, and drafts
 * moved onto it, use it instead of the global sticky pick or the thread the
 * user was looking at. Projects without a default keep sticky + carry.
 */
export function resolveNewThreadDraftModelSeed(input: {
  projectDefaultModelSelection: ModelSelection | null | undefined;
  carryModelSelection: ModelSelection | null;
}): NewThreadDraftModelSeed {
  const projectDefault = input.projectDefaultModelSelection ?? null;
  if (projectDefault !== null) {
    return { applySticky: false, modelSelection: projectDefault };
  }
  return { applySticky: true, modelSelection: input.carryModelSelection };
}

/**
 * Unsent drafts still carry the last global sticky harness in
 * `activeProvider`. That leftover must not beat a project pin — unless the
 * user has picked a model on this draft (`modelSelectionExplicit`).
 */
export function shouldHonorProjectDefaultModel(input: {
  isLocalDraftThread: boolean;
  modelSelectionExplicit: boolean | undefined;
  projectDefaultModelSelection: ModelSelection | null | undefined;
}): boolean {
  return (
    input.isLocalDraftThread &&
    input.modelSelectionExplicit !== true &&
    input.projectDefaultModelSelection != null
  );
}

/**
 * Pin-clear restore is per draft. ChatView stays mounted across draft
 * navigations, so a leftover pin key from the previous draft must not look
 * like this draft's pin was reset.
 */
export function shouldRestoreStickyAfterProjectPinClear(input: {
  previousDraftKey: string | null;
  previousModelKey: string | null;
  draftKey: string;
  projectDefaultModelKey: string | null;
}): boolean {
  return (
    input.previousDraftKey === input.draftKey &&
    input.previousModelKey != null &&
    input.projectDefaultModelKey == null
  );
}
