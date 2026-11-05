import { sanitizeNewRefName } from "@t3tools/shared/git";
import type { ComposerDraftWorkspaceSelection } from "../../state/use-composer-drafts";

export function resolveNewTaskBranchLabel(branchName: string | null): string {
  return branchName ?? "Choose branch";
}

export function shouldCheckoutNewTaskBranch(input: { readonly branchIsCurrent: boolean }): boolean {
  return !input.branchIsCurrent;
}

export function filterNewTaskBranches<T extends { readonly name: string }>(
  branches: ReadonlyArray<T>,
  rawQuery: string,
): ReadonlyArray<T> {
  const query = sanitizeNewRefName(rawQuery).toLowerCase();
  return query.length === 0
    ? branches
    : branches.filter((branch) => branch.name.toLowerCase().includes(query));
}

/**
 * The workspace a new-task draft starts in. The new-task flow, its send path and the home
 * pending-drafts list all resolve through this, so what each shows is what is sent.
 */
export function resolveNewTaskDraftWorkspace(input: {
  readonly selection: ComposerDraftWorkspaceSelection | undefined;
  readonly canChooseWorkspace: boolean;
  readonly isGitRepo: boolean;
}): ComposerDraftWorkspaceSelection {
  const selection = input.canChooseWorkspace ? input.selection : undefined;
  return input.isGitRepo ? (selection ?? { branch: null }) : { branch: null };
}
