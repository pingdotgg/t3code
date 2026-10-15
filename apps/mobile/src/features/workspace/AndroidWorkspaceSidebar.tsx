import type { ReactNode } from "react";

export function AndroidWorkspaceSidebar(props: {
  readonly children: ReactNode;
  readonly onRequestVisibility: () => void;
  readonly selectedPullRequestKey: string | null;
  readonly selectedIssueKey: string | null;
}) {
  return props.children;
}
