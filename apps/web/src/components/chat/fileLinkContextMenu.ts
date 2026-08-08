import type { ContextMenuItem, EditorId, EnvironmentId } from "@t3tools/contracts";

export type FileLinkContextMenuAction =
  | "open-in-folder"
  | "open"
  | "open-in-browser"
  | "copy-relative"
  | "copy-full";

export function resolveFileLinkEnvironmentId(
  threadEnvironmentId: EnvironmentId | undefined,
  activeEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  return threadEnvironmentId ?? activeEnvironmentId;
}

export function canRevealFileLinkInManager(input: {
  readonly connectionPhase: string | undefined;
  readonly supportsRevealRpc: boolean;
  readonly availableEditors: ReadonlyArray<EditorId>;
}): boolean {
  return (
    input.connectionPhase === "connected" &&
    input.supportsRevealRpc &&
    input.availableEditors.includes("file-manager")
  );
}

export function buildFileLinkContextMenuItems(input: {
  readonly canRevealInFileManager: boolean;
  readonly canOpenInBrowser: boolean;
}): readonly ContextMenuItem<FileLinkContextMenuAction>[] {
  return [
    ...(input.canRevealInFileManager
      ? ([{ id: "open-in-folder", label: "Open in folder" }] as const)
      : []),
    { id: "open", label: "Open in editor" },
    ...(input.canOpenInBrowser
      ? ([{ id: "open-in-browser", label: "Open in integrated browser" }] as const)
      : []),
    { id: "copy-relative", label: "Copy relative path" },
    { id: "copy-full", label: "Copy full path" },
  ];
}
