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
  iconOnly = false,
  value,
  options,
  onChange,
  className,
  labelClassName,
}: {
  label: string;
  triggerIcon?: ReactNode;
  triggerLabel?: string;
  /** Hides the words and chevron in a narrow column, leaving the icon. */
  labelClassName?: string;
  outlined?: boolean;
  iconOnly?: boolean;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
  className?: string;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={triggerLabel || iconOnly ? `${label}: ${current.label}` : label}
        title={iconOnly ? `${label}: ${current.label}` : undefined}
        render={
          outlined ? (
            <Button variant="secondary" size={iconOnly ? "icon" : "default"} />
          ) : (
            <Button variant="ghost-muted" size="sm" />
          )
        }
        className={cn("min-w-0", className)}
      >
        {iconOnly ? (
          <current.Icon aria-hidden className="size-4" />
        ) : (
          <>
            {triggerIcon ?? <current.Icon aria-hidden className="size-3.5 shrink-0" />}
            <span className={cn("truncate", labelClassName)}>{triggerLabel ?? current.label}</span>
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 text-dim-foreground", labelClassName)}
            />
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
