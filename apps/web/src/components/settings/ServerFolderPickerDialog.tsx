import {
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
} from "@t3tools/client-runtime/state/projects";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import type { EnvironmentId } from "@t3tools/contracts";
import { CornerLeftUpIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { getEnvironmentBrowsePlatform } from "../CommandPalette.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

const EMPTY_ENTRIES: never[] = [];

/** Picks a folder on the environment's machine, which may not be this one. */
export function ServerFolderPickerDialog({
  environmentId,
  title,
  submitLabel,
  initialPath,
  onPick,
  onClose,
}: {
  environmentId: EnvironmentId;
  title: string;
  submitLabel: string;
  initialPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(() => ensureBrowseDirectoryPath(initialPath));
  const platform = getEnvironmentBrowsePlatform(
    useEnvironmentPresentation(environmentId).presentation?.serverConfig?.environment.platform.os,
  );
  const access = useFilesystemReadAccess(environmentId);
  const browsePath = getFilesystemBrowsePath(query, platform);
  // Only a typed separator changes the directory, so filtering a name sends no requests.
  const browse = useEnvironmentQuery(
    access.canReadFiles && browsePath.isBrowsing && browsePath.directoryPath.length > 0
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browsePath.directoryPath },
        })
      : null,
  );
  const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(
    browse.data?.entries ?? EMPTY_ENTRIES,
    browsePath.filterQuery,
  );
  const chosenPath =
    exactEntry?.fullPath ??
    (browsePath.filterQuery.length === 0 ? (browse.data?.parentPath ?? null) : null);
  const parentPath = browsePath.canBrowseUp ? getBrowseParentPath(browsePath.directoryPath) : null;
  const error = access.error ?? browse.error;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosenPath !== null) onPick(chosenPath);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              font="mono"
              aria-label="Folder path"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="h-64 overflow-y-auto rounded-md border py-1 text-sm">
              {parentPath !== null ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-muted-foreground hover:bg-accent"
                  onClick={() => setQuery(parentPath)}
                >
                  <CornerLeftUpIcon className="size-3.5 shrink-0" aria-hidden />
                  ..
                </button>
              ) : null}
              {visibleEntries.map((entry) => (
                <button
                  key={entry.fullPath}
                  type="button"
                  className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left hover:bg-accent"
                  onClick={() => setQuery(ensureBrowseDirectoryPath(entry.fullPath))}
                >
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
              {error ? (
                <p className="px-2.5 py-1 text-destructive-foreground text-xs">{error}</p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={chosenPath === null}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
