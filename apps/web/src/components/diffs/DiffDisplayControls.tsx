import { Columns2Icon, Rows3Icon, Settings2Icon } from "lucide-react";
import { useId } from "react";

import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface DiffDisplayOption {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function DiffDisplayOptionRow({ label, ...props }: DiffDisplayOption) {
  const id = useId();
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 text-xs">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        {label}
      </label>
      <Switch id={id} size="sm" {...props} />
    </div>
  );
}

/** Workspace diffs, Code and Guide share the same saved display preferences. */
export function DiffDisplayControls({
  filters,
  onWhitespaceChange,
}: {
  /** View-specific filters; absent in the guide, where every chapter keeps its files. */
  filters?: ReadonlyArray<DiffDisplayOption>;
  onWhitespaceChange?: (checked: boolean) => void;
}) {
  const settings = useClientSettings();
  const updateSettings = updateClientSettings;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button size="icon-sm" variant="ghost" />}
              aria-label="Diff options"
            />
          }
        >
          <Settings2Icon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">Diff options</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="md" padding="none" aria-label="Diff options">
        <div className="px-3 py-2">
          <ToggleGroup
            aria-label="Diff layout"
            variant="segmented"
            className="w-full"
            value={[settings.diffLayout]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "stacked" || next === "split") updateSettings({ diffLayout: next });
            }}
          >
            <Toggle aria-label="Unified diff view" value="stacked" className="flex-1">
              <Rows3Icon className="size-3.5" />
              Unified
            </Toggle>
            <Toggle aria-label="Split diff view" value="split" className="flex-1">
              <Columns2Icon className="size-3.5" />
              Split
            </Toggle>
          </ToggleGroup>
        </div>
        <Separator />
        <div className="px-3 py-1.5">
          <DiffDisplayOptionRow
            label="Wrap lines"
            checked={settings.wordWrap}
            onCheckedChange={(checked) => updateSettings({ wordWrap: checked })}
          />
          <DiffDisplayOptionRow
            label="Hide whitespace changes"
            checked={settings.diffIgnoreWhitespace}
            onCheckedChange={
              onWhitespaceChange ?? ((checked) => updateSettings({ diffIgnoreWhitespace: checked }))
            }
          />
        </div>
        {filters && filters.length > 0 ? (
          <>
            <Separator />
            <div className="px-3 py-1.5">
              {filters.map((option) => (
                <DiffDisplayOptionRow key={option.label} {...option} />
              ))}
            </div>
          </>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
