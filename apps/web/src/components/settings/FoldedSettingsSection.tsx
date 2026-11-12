import { SettingsGroup } from "./SettingsGroup";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { useSettingsSearchTarget, useSettingsSearchTargetId } from "./settingsLayout";

export function FoldedSettingsSection({
  id,
  title,
  summary,
  control,
  headerPlacement = "inside",
  collapsedContent,
  children,
}: {
  readonly id: string;
  readonly title: ReactNode;
  readonly summary?: string | null;
  readonly control?: ReactNode;
  readonly headerPlacement?: "inside" | "outside";
  /** Shown under the header only while folded. */
  readonly collapsedContent?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLElement>(id);
  // A search jump lands inside the fold, so open it before the scroll runs.
  const [openedForTarget, setOpenedForTarget] = useState<string | null>(null);
  if (searchTargetId === id && openedForTarget !== id) {
    setOpenedForTarget(id);
    if (!open) setOpen(true);
  }

  if (headerPlacement === "outside") {
    return (
      <section id={id} ref={targetRef} tabIndex={-1} className="outline-none">
        <Collapsible open={open} onOpenChange={setOpen}>
          <div className="space-y-2.5">
            <div
              data-settings-scroll-target
              className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4"
            >
              <h2>
                <CollapsibleTrigger className="flex min-h-7 items-center gap-2 rounded-md text-sm font-normal text-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  {title}
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                      open && "rotate-90",
                    )}
                  />
                </CollapsibleTrigger>
              </h2>
              {control}
            </div>
            <CollapsiblePanel>
              <SettingsGroup>{children}</SettingsGroup>
            </CollapsiblePanel>
          </div>
        </Collapsible>
      </section>
    );
  }

  return (
    <section id={id} ref={targetRef} tabIndex={-1} className="outline-none">
      <Collapsible open={open} onOpenChange={setOpen} render={<SettingsGroup divided={false} />}>
        {/* On a narrow screen the controls drop below the title instead of covering it. */}
        <div className="flex flex-wrap items-center gap-x-4 px-3 sm:px-4">
          <CollapsibleTrigger className="flex min-h-11 min-w-0 flex-1 basis-40 items-center gap-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring rounded-md">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm font-medium">{title}</span>
            {summary ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
            ) : null}
          </CollapsibleTrigger>
          {control ? (
            <div className="ms-auto flex max-w-full items-center py-1.5">{control}</div>
          ) : null}
        </div>
        {!open && collapsedContent ? (
          <div className="border-t border-border/50 empty:hidden">{collapsedContent}</div>
        ) : null}
        <CollapsiblePanel>
          <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
            {children}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
