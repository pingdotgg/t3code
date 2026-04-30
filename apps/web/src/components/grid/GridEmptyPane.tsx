import { type EnvironmentId } from "@t3tools/contracts";
import { SquarePenIcon } from "lucide-react";

import { Button } from "../ui/button";

import { GridThreadPicker } from "./GridThreadPicker";

interface GridEmptyPaneProps {
  environmentId: EnvironmentId;
  excludedThreadKeys: ReadonlySet<string>;
  onSelectThread: (threadKey: string) => void;
  onRequestNewThread: () => void;
  densityClass: string;
}

export function GridEmptyPane({
  environmentId,
  excludedThreadKeys,
  onSelectThread,
  onRequestNewThread,
  densityClass,
}: GridEmptyPaneProps) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-background p-3 text-center">
      <div className="text-xs text-muted-foreground">Empty pane</div>
      <div className={`flex flex-col items-center gap-2 ${densityClass}`}>
        <GridThreadPicker
          environmentId={environmentId}
          excludedThreadKeys={excludedThreadKeys}
          onSelect={onSelectThread}
          triggerLabel="Pick thread"
        />
        <Button
          variant="outline"
          size="xs"
          className="gap-1.5"
          onClick={onRequestNewThread}
          aria-label="Start a new thread in this cell"
        >
          <SquarePenIcon className="size-3" />
          New thread
        </Button>
      </div>
      <div className="text-[10px] text-muted-foreground">
        Click a thread from the sidebar, or use "New thread".
      </div>
    </div>
  );
}
