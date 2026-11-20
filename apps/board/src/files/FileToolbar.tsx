import { Pencil } from "lucide-react";

import { CopyButton } from "../chat/CopyButton";
import type { EditAccess } from "../domain/artifact";
import { useCanWriteFiles } from "../state/files";
import { DownloadButton } from "./DownloadButton";
import { actionClass } from "./fileActions";
import type { FileTarget } from "./target";

export function FileToolbar({
  target,
  access,
  copy,
  onEdit,
  text,
}: {
  target: FileTarget;
  access: EditAccess;
  /** What Copy puts on the clipboard: the file's text, or its path when the file has none. */
  copy: { readonly label: string; readonly read: () => string };
  /** Null when the file cannot be opened for edit. */
  onEdit: (() => void) | null;
  text: string | null;
}) {
  const canWrite = useCanWriteFiles(target.environmentId);
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
        {target.path}
      </span>
      {!access.editable && (
        <span data-testid="read-only-reason" className="shrink-0 text-[11px] text-muted">
          {access.reason}
        </span>
      )}
      {access.editable && onEdit !== null && !canWrite && (
        <span data-testid="read-only-reason" className="shrink-0 text-[11px] text-muted">
          Read-only connection.
        </span>
      )}
      {access.editable && onEdit !== null && (
        <button
          type="button"
          disabled={!canWrite}
          onClick={onEdit}
          className={`${actionClass} text-fg`}
        >
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </button>
      )}
      <CopyButton read={copy.read} label={copy.label} />
      <DownloadButton target={target} text={text} />
    </div>
  );
}
