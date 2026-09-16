import { ArrowLeft, ArrowUpRight, PenTool } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { useRightPanelStore } from "~/rightPanelStore";
import { DesignCanvas } from "./DesignCanvas";
import type { threadDesigns } from "./threadDesigns";

export function DesignPanel({
  threadRef,
  designs,
  tabId,
  visible,
}: {
  threadRef: ScopedThreadRef;
  designs: ReturnType<typeof threadDesigns>;
  tabId: string | null;
  visible: boolean;
}) {
  const selected = designs.find((design) => design.tabId === tabId);
  const open = (id: string | null) => useRightPanelStore.getState().openDesign(threadRef, id);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-design-panel="">
      {selected ? (
        <>
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3">
            <Button variant="ghost" size="sm" onClick={() => open(null)}>
              <ArrowLeft className="size-3.5" /> All designs
            </Button>
            <span className="truncate text-xs text-muted-foreground">{selected.title}</span>
          </div>
          <DesignCanvas
            key={`${selected.tabId}:${selected.url}`}
            threadRef={threadRef}
            tabId={selected.tabId}
            path={selected.path}
            url={selected.url}
            visible={visible}
          />
        </>
      ) : (
        <div className="mx-auto flex w-full max-w-lg flex-col gap-6 overflow-auto px-6 py-8">
          <div>
            <h2 className="text-sm font-medium">Designs</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {designs.length
                ? "Choose a design to open its canvas."
                : "Use /design in this thread to create a design."}
            </p>
          </div>
          <div className="space-y-2">
            {designs.map((design) => (
              <button
                key={design.path}
                type="button"
                onClick={() => open(design.tabId)}
                className="group flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card/50 p-4 text-left transition-colors hover:border-border hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
                  <PenTool className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{design.title}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {design.path.split("/").at(-1)}
                  </span>
                </span>
                <ArrowUpRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
