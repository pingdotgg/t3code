import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { ArrowLeftIcon, CornerLeftUpIcon, FolderIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { ensureBrowseDirectoryPath, hasTrailingPathSeparator } from "../lib/projectPaths";
import { filesystemEnvironment } from "../state/filesystem";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerKeybindingsAtom } from "../state/server";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { buildBrowseGroups } from "./CommandPalette.logic";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { Button } from "./ui/button";

/** Browse an environment's filesystem with the same controls as Add project. */
export function DirectoryPicker({
  environmentId,
  platform,
  initialPath,
  label,
  onSelect,
  onClose,
}: {
  environmentId: EnvironmentId;
  platform: string;
  initialPath: string;
  label: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(ensureBrowseDirectoryPath(initialPath));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const path = getFilesystemBrowsePath(query, platform);
  const result = useEnvironmentQuery(
    path.isBrowsing
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: path.directoryPath },
        })
      : null,
  );
  const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(
    result.data?.entries ?? [],
    path.filterQuery,
  );
  const selectedPath = hasTrailingPathSeparator(query)
    ? result.data?.parentPath
    : exactEntry?.fullPath;
  const canSelect = Boolean(selectedPath && !result.isPending && !result.error && path.isBrowsing);
  const select = () => {
    if (canSelect && selectedPath) onSelect(selectedPath);
  };
  const navigate = (next: string) => {
    setHighlighted(null);
    setQuery(ensureBrowseDirectoryPath(next));
  };
  const up = () => {
    if (path.parentPath) navigate(path.parentPath);
  };
  const groups = buildBrowseGroups({
    browseEntries: visibleEntries,
    browseQuery: query,
    canBrowseUp: path.canBrowseUp,
    directoryIcon: <FolderIcon className="size-4" />,
    upIcon: <CornerLeftUpIcon className="size-4" />,
    browseUp: up,
    browseTo: (name) => {
      const entry = visibleEntries.find((item) => item.name === name);
      if (entry) navigate(entry.fullPath);
    },
  });
  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <CommandDialogPopup aria-label={label}>
        <CommandPaletteContent
          key={path.directoryPath}
          aria-label={label}
          mode="none"
          autoHighlight={false}
          value={query}
          onValueChange={setQuery}
          onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
          footerActionLabel="Select"
          showBackHint
          inputProps={{
            "aria-label": label,
            placeholder: "~/",
            className: "*:data-[slot=autocomplete-input]:pe-32!",
            wrapperClassName: "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto",
            startAddon: (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Parent directory"
                disabled={!path.canBrowseUp}
                onClick={up}
              >
                <ArrowLeftIcon />
              </Button>
            ),
            onKeyDown: (event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              } else if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey || !highlighted)
              ) {
                event.preventDefault();
                event.stopPropagation();
                select();
              } else if (
                event.key === "Backspace" &&
                event.currentTarget.selectionStart === 0 &&
                event.currentTarget.selectionEnd === 0
              ) {
                event.preventDefault();
                up();
              }
            },
          }}
          inputAccessory={
            <Button
              className="absolute right-3 top-3"
              size="sm"
              variant="outline"
              disabled={!canSelect}
              onClick={select}
            >
              Use folder
            </Button>
          }
        >
          {result.error ? (
            <p role="alert" className="p-4 text-sm text-destructive">
              {result.error}
            </p>
          ) : result.isPending ? (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              Loading directories…
            </p>
          ) : (
            <CommandPaletteResults
              groups={groups.some((group) => group.items.length > 0) ? groups : []}
              highlightedItemValue={highlighted}
              isActionsOnly
              keybindings={keybindings}
              emptyStateMessage={
                path.isBrowsing
                  ? "No matching directories."
                  : "Enter an absolute path or start with ~/."
              }
              onExecuteItem={(item) => {
                if (item.kind === "action") void item.run();
              }}
            />
          )}
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
