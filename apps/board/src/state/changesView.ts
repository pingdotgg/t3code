import { Atom, type AtomRegistry } from "effect/reactivity";
import type { ReviewDiffPreviewInput } from "@t3tools/contracts";

import { showPanelTab } from "../browser/panel";
import { trimSlashes } from "../files/target";
import { chooseRoot, type DiffSource, openFile } from "./filesView";

export interface ChangesPrefs {
  readonly layout: "unified" | "split";
  readonly ignoreWhitespace: boolean;
  /** The sidebar lists changed files as a tree of folders, not a flat list. */
  readonly asTree: boolean;
}

export const changesPrefsAtom = Atom.make<ChangesPrefs>({
  layout: "unified",
  ignoreWhitespace: false,
  asTree: false,
}).pipe(Atom.keepAlive, Atom.withLabel("changes-prefs"));

/** The request that reads one diff source of a checkout. Commits go by sha, the rest by source kind. */
export function previewInput(
  cwd: string,
  source: DiffSource,
  ignoreWhitespace: boolean,
): ReviewDiffPreviewInput {
  switch (source.kind) {
    case "working-tree":
      return { cwd, sourceKind: "working-tree", ignoreWhitespace };
    case "branch-range":
      return {
        cwd,
        sourceKind: "branch-range",
        ignoreWhitespace,
        ...(source.baseRef === null ? {} : { baseRef: source.baseRef }),
      };
    case "commit":
      return { cwd, commitSha: source.sha, ignoreWhitespace };
  }
}

/** Shows a checkout's changes: the Source Control tab on its root, and its branch diff as a tab in the main view. */
export function openChanges(
  registry: AtomRegistry.AtomRegistry,
  root: { readonly cwd: string; readonly base: string | null },
): void {
  const cwd = trimSlashes(root.cwd);
  showPanelTab(registry, "changes");
  chooseRoot(registry, cwd);
  openFile(registry, { cwd, path: "", diff: { kind: "branch-range", baseRef: root.base } });
}

/** Opens a ticket's branch diff, which a ticket without a worktree has none of. */
export function openTicketChanges(
  registry: AtomRegistry.AtomRegistry,
  ticket: { readonly worktreePath?: string | null; readonly base?: string | null },
): void {
  if (ticket.worktreePath == null) return;
  openChanges(registry, { cwd: ticket.worktreePath, base: ticket.base ?? null });
}
