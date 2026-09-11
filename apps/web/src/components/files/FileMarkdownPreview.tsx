import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatMarkdown from "~/components/ChatMarkdown";
import { remarkSourceLineAnchors } from "~/markdown-source-line-anchors";
import { resolvePathLinkTarget } from "~/terminal-links";

const FILE_MARKDOWN_REMARK_PLUGINS = [remarkSourceLineAnchors];

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
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
    <ChatMarkdown
      text={props.text}
      cwd={props.cwd}
      imageBaseDir={imageBaseDir}
      threadRef={props.threadRef}
      className="mx-auto max-w-4xl px-6 py-5"
      extraRemarkPlugins={FILE_MARKDOWN_REMARK_PLUGINS}
      onTaskListChange={props.onTaskListChange}
    />
  );
}
