import type { ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { RadioGroup } from "../ui/radio-group";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

/** One option in an {@link OptionRowGrid}. */
export interface OptionRowItem {
  readonly id: string;
  readonly label: string;
  /** Rendered left of the label; pickers pass their provider icon. */
  readonly icon: ReactNode;
  readonly badgeLabel?: string | undefined;
}

/** One-per-line option rows, as the Add provider dialog lists its providers. */
export function OptionRowGrid({
  items,
  value,
  disabled,
  onValueChange,
  ...labelProps
}: {
  readonly items: ReadonlyArray<OptionRowItem>;
  /** The picked item's id, or null when nothing is picked. */
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onValueChange: (value: string) => void;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
}) {
  return (
    <RadioGroup
      {...labelProps}
      disabled={disabled}
      value={value}
      onValueChange={onValueChange}
      className="grid grid-cols-1 sm:grid-cols-2"
    >
      {items.map((item) => (
        <RadioPrimitive.Root
          key={item.id}
          value={item.id}
          className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
        >
          {item.icon}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {item.label}
          </span>
          <RadioPrimitive.Indicator
            className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
            aria-hidden
          >
            <CheckIcon className="size-3.5 shrink-0" />
          </RadioPrimitive.Indicator>
          {item.badgeLabel ? (
            <Badge variant="warning" size="sm">
              {item.badgeLabel}
            </Badge>
          ) : null}
        </RadioPrimitive.Root>
      ))}
    </RadioGroup>
  );
}

/** A rule with words between, dividing one option group from another. */
export function OptionListDivider({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <div aria-hidden className="flex-1 border-t border-border/70" />
      <span>{children}</span>
      <div aria-hidden className="flex-1 border-t border-border/70" />
    </div>
  );
}

/** The fold holding further options behind a Show more toggle. */
export function ShowMoreCollapsible({
  open,
  onOpenChange,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="flex pt-2">
        <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
          {open ? "Show less" : "Show more"}
          <ChevronDownIcon
            aria-hidden
            className={cn("transition-transform", open && "rotate-180")}
          />
        </CollapsibleTrigger>
      </div>
      {/* The surrounding panel already animates its height, so the fold opens without its own. */}
      <CollapsiblePanel animate={false}>
        <div className="pt-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
