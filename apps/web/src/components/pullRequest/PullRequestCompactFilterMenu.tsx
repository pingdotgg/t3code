import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestFilterOptionIcon,
  type PullRequestFilterOption,
} from "./PullRequestListFilters";

export function PullRequestCompactFilterMenu<Value extends string>({
  label,
  triggerIcon,
  triggerLabel,
  outlined = false,
  grouped = false,
  iconOnly = false,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  triggerIcon?: ReactNode;
  triggerLabel?: string;
  outlined?: boolean;
  /** A ghost button for a ToolbarGroup, 26px like the pill's icon buttons. */
  grouped?: boolean;
  /** Shows only the icon: `triggerIcon`, else the chosen option's own. */
  iconOnly?: boolean;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
  className?: string;
}) {
  const gt = useGT();
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  const valueLabel = gt("{label}: {value}", { label, value: current.label });
  return (
    <Menu>
      <MenuTrigger
        aria-label={triggerLabel || iconOnly ? valueLabel : label}
        title={iconOnly ? valueLabel : undefined}
        render={
          grouped ? (
            <Button variant="ghost-muted" size={iconOnly ? "icon-toolbar" : "toolbar"} />
          ) : outlined ? (
            <Button variant="outline" size={iconOnly ? "icon" : "default"} />
          ) : (
            <Button variant="ghost-muted" size="sm" />
          )
        }
        className={cn("min-w-0", className)}
      >
        {iconOnly ? (
          (grouped && triggerIcon) || <current.Icon aria-hidden className="size-4" />
        ) : triggerLabel ? (
          <>
            {triggerIcon}
            <span>{triggerLabel}</span>
          </>
        ) : (
          <>
            <span className="truncate">{current.label}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
          {options.map((option) => {
            const item = (
              <MenuRadioItem
                key={option.value}
                value={option.value}
                disabled={option.unavailable !== undefined}
                className="data-disabled:pointer-events-auto"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <PullRequestFilterOptionIcon option={option} />
                  {option.label}
                </span>
              </MenuRadioItem>
            );
            return option.unavailable === undefined ? (
              item
            ) : (
              <Tooltip key={option.value}>
                <TooltipTrigger render={item} />
                <TooltipPopup side="right">{option.unavailable}</TooltipPopup>
              </Tooltip>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
