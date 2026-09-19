import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

export interface RemoveProjectsConfirmation {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
}

export interface RemoveProjectsMember extends Pick<
  EnvironmentProject,
  "environmentId" | "id" | "title" | "workspaceRoot"
> {
  readonly environmentLabel?: string | null;
}

/**
 * Copy for the destructive confirmation before removing project entries. It
 * mirrors the web project settings dialog: removing every checkout of a
 * grouped project is a "project" removal, anything less is a "checkout"
 * removal that leaves the other entries alone.
 */
export function buildRemoveProjectsConfirmation(input: {
  readonly members: ReadonlyArray<RemoveProjectsMember>;
  readonly groupTitle: string;
  /** Whether removing these members empties the whole grouped project. */
  readonly isWholeGroup: boolean;
  readonly threadCount: number;
}): RemoveProjectsConfirmation {
  const singleMember = input.members.length === 1 ? input.members[0]! : null;
  const targetKind = input.isWholeGroup ? "project" : "checkout";
  const targetLabel = singleMember?.title ?? input.groupTitle;
  const lines = [
    input.threadCount > 0
      ? `This deletes its ${input.threadCount} thread${input.threadCount === 1 ? "" : "s"} and permanently clears their conversation history, including archived threads.`
      : "This permanently clears any archived conversation history.",
    ...(singleMember
      ? [
          `Path: ${singleMember.workspaceRoot}`,
          ...(singleMember.environmentLabel
            ? [`Environment: ${singleMember.environmentLabel}`]
            : []),
        ]
      : [`This removes ${input.members.length} grouped project entries.`]),
    input.isWholeGroup
      ? "Only the project entry is removed. Files on disk are not touched."
      : "Other checkouts in this project are unaffected.",
    "This action cannot be undone.",
  ];
  return {
    title: `Remove ${targetKind} “${targetLabel}”?`,
    message: lines.join("\n"),
    confirmText: "Remove",
  };
}
