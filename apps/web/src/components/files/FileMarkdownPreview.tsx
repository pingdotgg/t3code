import type { ScopedThreadRef } from "@t3tools/contracts";
import type { KeyboardEvent } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { isEditableFocused } from "~/lib/editableFocus";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

// The rendered preview is not editable, so select-all would otherwise cover the whole window.
function selectPreviewText(event: KeyboardEvent<HTMLDivElement>) {
  if (
    event.key.toLowerCase() !== "a" ||
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.shiftKey ||
    (isEditableFocused(event.target) &&
      !(event.target instanceof HTMLInputElement && event.target.type === "checkbox"))
  ) {
    return;
  }
  event.preventDefault();
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator), props.cwd)
      : props.cwd;

  return (
    // Focusable so a click inside gives it focus and its key handler sees Cmd/Ctrl+A.
    <div tabIndex={-1} className="outline-none" onKeyDown={selectPreviewText}>
      <ChatMarkdown
        text={maskMarkdownFrontmatter(props.text)}
        cwd={props.cwd}
        imageBaseDir={imageBaseDir}
        threadRef={props.threadRef}
        workspaceMutationId={props.workspaceMutationId}
        className="mx-auto max-w-4xl px-6 py-5"
        onTaskListChange={props.onTaskListChange}
      />
    </div>
  );
}
