import type { IssueState } from "@t3tools/contracts";

/** The tracker's own state name, styled by the category every tracker shares. */
export function issueStatus(state: IssueState) {
  return state.category === "open"
    ? ({
        label: state.name,
        icon: "circle.inset.filled",
        tint: "accent-adaptive-emerald-600-400",
        text: "text-adaptive-emerald-600-400",
      } as const)
    : ({
        label: state.name,
        icon: "checkmark.circle",
        tint: "accent-adaptive-violet-600-400",
        text: "text-adaptive-violet-600-400",
      } as const);
}
