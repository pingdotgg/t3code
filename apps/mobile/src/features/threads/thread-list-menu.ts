import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export function buildThreadListMenuActions(input: {
  readonly thread: Pick<EnvironmentThreadShell, "branch" | "titleRegeneration">;
  readonly lifecycleActions: ReadonlyArray<MenuAction>;
  readonly titleRegenerationSupported: boolean;
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
    ...input.lifecycleActions,
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
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
}
