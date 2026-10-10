import type { EnvironmentId, SkillFolderInfo } from "@t3tools/contracts";
import { FileIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import {
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "../files/fileSurfaceChrome";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Badge } from "../ui/badge";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

/** A skill's files and one file's text, read-only, to check what a skill does. */
export function SkillFilesDialog({
  open,
  onOpenChange,
  environmentId,
  name,
  folder,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly folder: SkillFolderInfo;
}) {
  const [selected, setSelected] = useState("SKILL.md");
  const file = useProjectFileQuery(environmentId, folder.folder, selected, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>
              <span className="font-mono">{name}</span>
            </DialogTitle>
            {folder.scripts ? (
              <Badge variant="warning" size="sm">
                <TriangleAlertIcon />
                Includes scripts
              </Badge>
            ) : null}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{folder.folder}</p>
        </DialogHeader>
        <div className="flex h-[min(60vh,32rem)] min-h-0 border-t">
          <ul className="w-56 shrink-0 overflow-y-auto border-e py-1" aria-label="Files">
            {folder.files.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1 text-start font-mono text-xs hover:bg-accent",
                    entry.path === selected && "bg-accent",
                  )}
                  aria-current={entry.path === selected || undefined}
                  onClick={() => setSelected(entry.path)}
                >
                  <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                  {entry.executable ? (
                    <span className="text-2xs text-warning-foreground">script</span>
                  ) : null}
                </button>
              </li>
            ))}
            {folder.filesTruncated ? (
              <li className="px-3 py-1 text-xs text-muted-foreground">More files not shown</li>
            ) : null}
          </ul>
          <div className="flex min-w-0 flex-1 flex-col">
            {file.data?.truncated ? (
              <FileSurfaceNotice>Showing the first 1 MB.</FileSurfaceNotice>
            ) : null}
            {file.data !== null ? (
              <div className="min-h-0 flex-1 overflow-auto">
                <ReadOnlySourcePreview name={selected} text={file.data.contents} />
              </div>
            ) : file.readError?.failure === "binary_file" ? (
              <FileSurfaceFailure message="This file isn't text." />
            ) : file.error !== null ? (
              <FileSurfaceFailure message={file.error} onRetry={file.refresh} />
            ) : (
              <FileSurfaceLoading className="flex-1" />
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
