import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/**
 * Mirrors web's buildThreadActionMenuItems grouping:
 * lifecycle → title/meta → Copy submenu → Archive/Delete tail.
 */
export function buildThreadListMenuActions(input: {
  readonly thread: Pick<EnvironmentThreadShell, "branch" | "id" | "titleRegeneration">;
  readonly lifecycleActions: ReadonlyArray<MenuAction>;
  readonly titleRegenerationSupported: boolean;
  /** Set when the lifecycle slot is taken by settle/wake/unsettle, so
      Archive doesn't appear twice on rows whose fallback is already
      archive (legacy servers, compact list). */
  readonly showArchiveAction?: boolean;
  /** Archive rejects a thread with an active turn, so disable it here
      rather than let the action fail. Same computation as web:
      session.status === "running" && activeTurnId != null. */
  readonly isRunning?: boolean;
}): MenuAction[] {
  const regeneratingTitle = input.thread.titleRegeneration != null;
  return [
    ...(input.thread.branch
      ? [
          {
            id: "new-thread-on-branch",
            title: `New thread on ${input.thread.branch}`,
            image: "plus",
          } satisfies MenuAction,
        ]
      : []),
    // Archive rejects a thread with an active turn; rows that surface it as
    // their lifecycle action get the same disabled treatment as the tail.
    ...input.lifecycleActions.map((action) =>
      action.id === "archive" && input.isRunning === true
        ? { ...action, attributes: { ...action.attributes, disabled: true } }
        : action,
    ),
    {
      id: "thread-title-actions",
      title: "",
      displayInline: true,
      subactions: [
        { id: "rename", title: "Rename thread", image: "square.and.pencil" },
        ...(input.titleRegenerationSupported
          ? [
              {
                id: "regenerate-title",
                title: regeneratingTitle ? "Regenerating…" : "Regenerate title",
                image: "arrow.clockwise",
                attributes: { disabled: regeneratingTitle },
              } satisfies MenuAction,
            ]
          : []),
        { id: "mark-unread", title: "Mark unread", image: "envelope.badge" },
      ],
    },
    {
      id: "copy",
      title: "Copy",
      image: "doc.on.doc",
      subactions: [
        { id: "copy-path", title: "Path", image: "folder" },
        ...(input.thread.branch
          ? [
              {
                id: "copy-branch",
                title: "Branch",
                image: "arrow.triangle.branch",
              } satisfies MenuAction,
            ]
          : []),
        { id: "copy-thread-id", title: "Thread ID", image: "number" },
      ],
    },
    {
      id: "thread-delete-actions",
      title: "",
      displayInline: true,
      subactions: [
        ...(input.showArchiveAction === false
          ? []
          : [
              {
                id: "archive",
                title: "Archive thread",
                image: "archivebox",
                attributes: { disabled: input.isRunning === true },
              } satisfies MenuAction,
            ]),
        { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
      ],
    },
  ];
}
