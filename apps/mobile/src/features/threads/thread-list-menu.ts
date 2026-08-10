import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export function buildThreadListMenuActions(input: {
  readonly thread: Pick<EnvironmentThreadShell, "branch" | "titleRegeneration">;
  readonly lifecycleActions: ReadonlyArray<MenuAction>;
  readonly titleRegenerationSupported: boolean;
}): MenuAction[] {
  const regeneratingTitle = input.thread.titleRegeneration != null;
  const titleActions: MenuAction[] = [
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
  ];
  const utilityActions: MenuAction[] = [
    { id: "mark-unread", title: "Mark unread", image: "envelope.badge" },
    { id: "copy-path", title: "Copy path", image: "doc.on.doc" },
    ...(input.thread.branch
      ? [
          {
            id: "copy-branch",
            title: "Copy branch",
            image: "arrow.triangle.branch",
          } satisfies MenuAction,
        ]
      : []),
  ];
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
    ...input.lifecycleActions,
    {
      id: "thread-title-actions",
      title: "",
      displayInline: true,
      subactions: titleActions,
    },
    {
      id: "thread-utility-actions",
      title: "",
      displayInline: true,
      subactions: utilityActions,
    },
    {
      id: "thread-delete-actions",
      title: "",
      displayInline: true,
      subactions: [
        { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
      ],
    },
  ];
}
