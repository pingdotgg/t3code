import type { AppBarConfirm } from "../../components/ui/AppBar.types";
import {
  resolveThreadPrBadgeAction,
  type ThreadPrPresentation,
} from "../../state/thread-pr-presentation";

type GitQuickAction = {
  readonly kind: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly action?: string;
};

/** Short pill copy for the thread-bar CTA — full quick-action label stays in a11y. */
export function shortGitBarLabel(
  quickAction: GitQuickAction,
  shortLabel: string,
  openPrNumber?: number | null,
): { readonly label: string; readonly disabled: boolean } | null {
  if (quickAction.kind === "open_pr") {
    return {
      label: openPrNumber != null ? `#${openPrNumber}` : "View",
      disabled: quickAction.disabled,
    };
  }
  if (quickAction.kind === "run_pull") {
    return { label: "Pull", disabled: quickAction.disabled };
  }
  if (quickAction.kind === "run_action") {
    switch (quickAction.action) {
      case "create_pr":
      case "commit_push_pr":
        return { label: shortLabel, disabled: quickAction.disabled };
      case "push":
        return { label: "Push", disabled: quickAction.disabled };
      case "commit":
        return { label: "Commit", disabled: quickAction.disabled };
      case "commit_push":
        // Default-branch ahead uses action commit_push with label "Push".
        return {
          label: quickAction.label === "Push" ? "Push" : "Commit",
          disabled: quickAction.disabled,
        };
      default:
        return null;
    }
  }
  return null;
}

/** Linked-PR bar confirm: number for one; count label when several. */
export function linkedPrBarConfirm(
  pr: ThreadPrPresentation,
): Pick<AppBarConfirm, "label" | "icon" | "showLabel" | "accessibilityLabel"> {
  const multi = resolveThreadPrBadgeAction(pr).kind === "list";
  return {
    // Liquid Glass Toolbar.Button drops the title when an icon is set, so multi stays label-only
    // (`+3` / stack depth) — same Edit-style glass text as a single `#32394`.
    label: multi ? pr.label : `#${pr.number}`,
    showLabel: true,
    accessibilityLabel: pr.accessibilityLabel,
  };
}
