import type { ContextMenuItem, ProjectEntry } from "@t3tools/contracts";

export type FileBrowserContextMenuAction = "download" | "copy-mention" | "add-to-chat";

export function buildFileBrowserContextMenuItems(
  kind: ProjectEntry["kind"] | undefined,
): readonly ContextMenuItem<FileBrowserContextMenuAction>[] {
  return [
    ...(kind === "file" ? [{ id: "download" as const, label: "Download" }] : []),
    { id: "copy-mention", label: "Copy mention" },
    { id: "add-to-chat", label: "Add to chat" },
  ];
}
