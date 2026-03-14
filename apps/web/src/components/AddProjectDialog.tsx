import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { FolderIcon } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "~/components/ui/command";
import { readNativeApi } from "../nativeApi";

interface BrowseEntry {
  name: string;
  fullPath: string;
}

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddProject: (path: string) => void;
}

export function AddProjectDialog({ open, onOpenChange, onAddProject }: AddProjectDialogProps) {
  const [inputValue, setInputValue] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const [debouncedPath] = useDebouncedValue(inputValue, { wait: 200 });

  const { data: entries = [] } = useQuery({
    queryKey: ["filesystemBrowse", debouncedPath],
    queryFn: async () => {
      const api = readNativeApi();
      if (!api) return [];
      const result = await api.projects.browseFilesystem({ partialPath: debouncedPath });
      return result.entries;
    },
    enabled: open && debouncedPath.length > 0,
  });

  useEffect(() => {
    setHighlightedIndex(0);
  }, [entries]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setInputValue("");
        setHighlightedIndex(0);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const addProject = useCallback(
    (path: string) => {
      onAddProject(path);
      close();
    },
    [onAddProject, close],
  );

  const drillInto = useCallback((entry: BrowseEntry) => {
    setInputValue(entry.fullPath + "/");
    inputRef.current?.focus();
  }, []);

  const getHighlightedEntry = () =>
    entries.length > 0 ? entries[Math.min(highlightedIndex, entries.length - 1)] : null;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const highlighted = getHighlightedEntry();

    switch (event.key) {
      case "Tab":
        event.preventDefault();
        if (highlighted) drillInto(highlighted);
        break;
      case "Enter":
        event.preventDefault();
        if (highlighted) addProject(highlighted.fullPath);
        else if (inputValue.trim()) addProject(inputValue.trim());
        break;
      case "ArrowDown":
        event.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, entries.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
    }
  };

  return (
    <CommandDialog open={open} onOpenChange={handleOpenChange}>
      <CommandDialogPopup>
        <Command>
          <CommandPanel>
            <CommandInput
              ref={inputRef}
              placeholder="Enter project path (e.g. ~/projects/my-app)"
              startAddon={<FolderIcon />}
              value={inputValue}
              onChange={(e) => setInputValue(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
            />
            <CommandList>
              {entries.map((entry, index) => (
                <CommandItem
                  key={entry.fullPath}
                  data-highlighted={index === highlightedIndex ? "" : undefined}
                  onPointerMove={() => setHighlightedIndex(index)}
                  onClick={() => drillInto(entry)}
                >
                  <FolderIcon className="mr-2 size-4 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {entry.fullPath}
                  </span>
                </CommandItem>
              ))}
            </CommandList>
            {inputValue.trim() && (
              <div className="border-t px-4 py-2">
                <button
                  type="button"
                  className="w-full cursor-pointer rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => addProject(inputValue.trim())}
                >
                  Add project at <span className="font-medium">{inputValue.trim()}</span>
                </button>
              </div>
            )}
          </CommandPanel>
          <CommandFooter>
            <span>Tab to autocomplete &middot; Enter to add project</span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
