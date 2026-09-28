import type { MenuAction } from "@react-native-menu/menu";

interface ThreadCopySource {
  readonly id: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export type ThreadCopyTarget = "path" | "branch" | "thread-id";

const COPY_TARGET_BY_EVENT: Readonly<Record<string, ThreadCopyTarget>> = {
  "copy-path": "path",
  "copy-branch": "branch",
  "copy-thread-id": "thread-id",
};

/** Copy submenu for a thread row, ordered and labelled like the web thread menu. */
export function buildThreadCopyMenuItem(thread: Pick<ThreadCopySource, "branch">): MenuAction {
  return {
    id: "copy",
    title: "Copy",
    image: "doc.on.doc",
    subactions: [
      { id: "copy-path", title: "Path", image: "folder" },
      ...(thread.branch ? [{ id: "copy-branch", title: "Branch", image: "arrow.branch" }] : []),
      { id: "copy-thread-id", title: "Thread ID", image: "number" },
    ],
  };
}

/**
 * Resolves a menu event to the text it copies. `value` is null when the thread
 * has nothing to copy for that target, e.g. a local thread in a project with no
 * known workspace root. Returns null for events that are not copy actions.
 */
export function resolveThreadCopy(
  event: string,
  thread: ThreadCopySource,
  workspaceRoot: string | null | undefined,
): { readonly target: ThreadCopyTarget; readonly value: string | null } | null {
  const target = COPY_TARGET_BY_EVENT[event];
  if (target === undefined) return null;
  switch (target) {
    case "path":
      return { target, value: thread.worktreePath ?? workspaceRoot ?? null };
    case "branch":
      return { target, value: thread.branch };
    case "thread-id":
      return { target, value: thread.id };
  }
}
