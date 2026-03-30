import type { Project, Thread } from "./types";

export function isWorkspaceStateAvailable(
  state: Project["workspaceState"] | Thread["effectiveCwdState"],
): boolean {
  return state === "available";
}

export function isProjectWorkspaceAvailable(project: Pick<Project, "workspaceState">): boolean {
  return isWorkspaceStateAvailable(project.workspaceState);
}

export function isThreadWorkspaceAvailable(thread: Pick<Thread, "effectiveCwdState">): boolean {
  return isWorkspaceStateAvailable(thread.effectiveCwdState);
}

export function workspaceUnavailableReason(input: {
  state: Project["workspaceState"] | Thread["effectiveCwdState"];
  kind: "project" | "worktree";
}): string | null {
  if (input.state === "available") {
    return null;
  }

  const subject = input.kind === "project" ? "Project folder" : "Worktree";
  switch (input.state) {
    case "missing":
      return `${subject} is missing.`;
    case "not_directory":
      return `${subject} path is not a folder.`;
    case "inaccessible":
    default:
      return `${subject} is inaccessible.`;
  }
}
