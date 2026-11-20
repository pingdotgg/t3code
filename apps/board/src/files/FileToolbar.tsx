import { CopyButton } from "../chat/CopyButton";
import { DownloadButton } from "./DownloadButton";
import { OpenInEditor } from "./OpenInEditor";
import { absolutePathOf, type FileTarget } from "./target";

export function FileToolbar({
  target,
  copy,
  text,
}: {
  target: FileTarget;
  /** What Copy puts on the clipboard: the file's text, or its path when the file has none. */
  copy: { readonly label: string; readonly read: () => string };
  text: string | null;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
        {absolutePathOf(target)}
        {target.line !== undefined && `:${target.line}`}
      </span>
      <CopyButton read={copy.read} label={copy.label} />
      <DownloadButton target={target} text={text} />
      <OpenInEditor target={target} />
    </div>
  );
}
