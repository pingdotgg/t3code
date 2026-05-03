import { cn } from "~/lib/utils";

/** Browser-window thumbnail glyph for the "Local" recommendation cards. */
export function BrowserMockup({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex flex-col gap-0.5 overflow-hidden rounded-[5px] border border-border/60 bg-card p-1 shadow-xs/5",
        className,
      )}
    >
      <div className="flex gap-[2px]">
        <span className="size-[3px] rounded-full bg-destructive/80" />
        <span className="size-[3px] rounded-full bg-warning/80" />
        <span className="size-[3px] rounded-full bg-success/80" />
      </div>
      <div className="mt-[1px] flex flex-1 flex-col gap-[2px]">
        <span className="h-[2px] w-full rounded-full bg-muted-foreground/30" />
        <span className="h-[2px] w-3/5 rounded-full bg-muted-foreground/20" />
      </div>
    </div>
  );
}
