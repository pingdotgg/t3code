import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import {
  PullRequestFilterOptionIcon,
  type PullRequestFilterOption,
} from "./PullRequestListFilters";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function PullRequestCompactFilterMenu<Value extends string>({
  label,
  triggerIcon,
  triggerLabel,
  iconOnly = false,
  value,
  options,
  onChange,
}: {
  label: string;
  triggerIcon?: ReactNode;
  triggerLabel?: string;
  iconOnly?: boolean;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  const gt = useGT();
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={
          triggerLabel || iconOnly ? gt("{label}: {value}", { label, value: current.label }) : label
        }
        title={iconOnly ? gt("{label}: {value}", { label, value: current.label }) : undefined}
        render={<Button variant="secondary" size={iconOnly ? "icon" : "default"} />}
        className="min-w-0"
      >
        {iconOnly ? (
          <current.Icon aria-hidden className="size-4" />
        ) : (
          <>
            {triggerIcon ?? <current.Icon aria-hidden className="size-4 shrink-0" />}
            <span className="truncate">{triggerLabel ?? current.label}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-dim-foreground" />
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
              <SharedTooltipTrigger
                key={option.value}
                render={item}
                label={option.unavailable}
                side="right"
              />
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
