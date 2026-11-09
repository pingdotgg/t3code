import { ArrowLeftIcon, FolderIcon, XIcon } from "lucide-react";

import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "./CommandPalette.logic";
import { Button } from "./ui/button";
import { DialogTitle } from "./ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { ScrollArea } from "./ui/scroll-area";

export function CreateProjectForm(props: {
  readonly name: string;
  readonly folder: string | null;
  readonly sources: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  readonly pending: boolean;
  readonly canSubmit: boolean;
  readonly onNameChange: (name: string) => void;
  readonly onSelectSource: (source: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
  readonly onClearFolder: () => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
  readonly onBack?: () => void;
}) {
  return (
    <form
      data-create-project-form=""
      className="flex min-h-0 flex-col gap-5 overflow-y-auto p-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.canSubmit) props.onSubmit();
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {props.onBack ? (
            <Button variant="ghost-muted" size="icon-sm" aria-label="Back" onClick={props.onBack}>
              <ArrowLeftIcon />
            </Button>
          ) : null}
          <DialogTitle>Create project</DialogTitle>
        </div>
        <Button variant="ghost-muted" size="icon-sm" aria-label="Close" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      <InputGroup size="lg">
        <InputGroupAddon>
          <FolderIcon />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          aria-label="Project name"
          placeholder="Project name"
          value={props.name}
          disabled={props.pending}
          onValueChange={props.onNameChange}
        />
      </InputGroup>
      <div className="flex shrink-0 flex-col gap-2">
        <div className="text-xs font-medium text-foreground">
          Source <span className="font-normal text-muted-foreground">(optional)</span>
        </div>
        <div className="shrink-0 overflow-hidden rounded-xl border border-border bg-muted/30">
          {props.folder ? (
            <div className="flex items-center gap-3 p-3">
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-all text-sm">{props.folder}</span>
              <Button
                variant="ghost-muted"
                size="xs"
                disabled={props.pending}
                onClick={props.onClearFolder}
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="h-48">
              <ScrollArea>
                <div className="p-1.5">
                  {props.sources.map((source) => (
                    <div
                      key={source.value}
                      className="flex items-center gap-2 rounded-lg pe-2 hover:bg-accent/50"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-45"
                        disabled={source.disabled || props.pending}
                        onClick={() => props.onSelectSource(source)}
                      >
                        <span className="shrink-0 text-muted-foreground">{source.icon}</span>
                        <span className="truncate">{source.title}</span>
                      </button>
                      {source.titleTrailingContent}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-border/70 pt-4">
        <Button variant="ghost-muted" onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!props.canSubmit}>
          {props.pending ? "Creating…" : "Create project"}
        </Button>
      </div>
    </form>
  );
}
