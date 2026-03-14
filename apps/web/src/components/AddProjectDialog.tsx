import { useCallback, useEffect, useRef, useState } from "react";
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
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const browse = useCallback(async (partialPath: string) => {
    if (!partialPath) {
      setEntries([]);
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    try {
      const result = await api.projects.browseFilesystem({ partialPath });
      setEntries(result.entries);
      setHighlightedIndex(0);
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setInputValue("");
      setEntries([]);
      setHighlightedIndex(0);
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void browse(inputValue);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputValue, open, browse]);

  const selectEntry = useCallback(
    (entry: BrowseEntry) => {
      const nextValue = entry.fullPath + "/";
      setInputValue(nextValue);
      void browse(nextValue);
      inputRef.current?.focus();
    },
    [browse],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        if (entries.length > 0) {
          const idx = Math.min(highlightedIndex, entries.length - 1);
          const entry = entries[idx];
          if (entry) {
            selectEntry(entry);
          }
        }
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        if (entries.length > 0) {
          const idx = Math.min(highlightedIndex, entries.length - 1);
          const entry = entries[idx];
          if (entry) {
            selectEntry(entry);
          }
        } else if (inputValue.trim()) {
          onAddProject(inputValue.trim());
          onOpenChange(false);
        }
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, entries.length - 1));
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
    },
    [entries, highlightedIndex, inputValue, onAddProject, onOpenChange, selectEntry],
  );

  const handleSubmitDirect = useCallback(() => {
    if (inputValue.trim()) {
      onAddProject(inputValue.trim());
      onOpenChange(false);
    }
  }, [inputValue, onAddProject, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
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
                  onClick={() => selectEntry(entry)}
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
                  onClick={handleSubmitDirect}
                >
                  Add project at <span className="font-medium">{inputValue.trim()}</span>
                </button>
              </div>
            )}
          </CommandPanel>
          <CommandFooter>
            <span>Tab to autocomplete &middot; Enter to drill down &middot; Enter on empty to add project</span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
