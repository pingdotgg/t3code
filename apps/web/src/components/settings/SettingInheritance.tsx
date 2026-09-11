import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { CheckIcon, LayersIcon } from "lucide-react";
import * as Equal from "effect/Equal";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { isProjectScopedSettingKey } from "./scopedSettings";

interface InheritanceLayer {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly effective: boolean;
  readonly set: boolean;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value === "" ? "Empty" : value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (typeof value === "object" && "model" in value && typeof value.model === "string") {
    return value.model;
  }
  if (typeof value === "object" && "mode" in value && typeof value.mode === "string") {
    return value.mode;
  }
  return "Custom";
}

/**
 * The layers a setting resolves through for one target, bottom-up: built-in
 * default, the environment's value, and the project override when one is set.
 * The first set layer from the top is the effective one.
 */
export function settingInheritanceLayers(
  target: ScopedSettingsTarget,
  environmentSettings: ServerSettings,
  key: keyof ServerSettings,
): readonly InheritanceLayer[] {
  const builtIn = DEFAULT_SERVER_SETTINGS[key];
  const environmentValue = environmentSettings[key];
  const projectSource = isProjectScopedSettingKey(key) ? target.sources[key] : "environment";
  const environmentSet = !Equal.equals(environmentValue, builtIn);
  const layers: InheritanceLayer[] = [];
  if (target.projectId !== null && isProjectScopedSettingKey(key)) {
    layers.push({
      key: "project",
      label: "Project override",
      value: projectSource === "project" ? formatValue(target.settings[key]) : "Inherits",
      effective: projectSource === "project",
      set: projectSource === "project",
    });
  }
  layers.push({
    key: "environment",
    label: target.label,
    value: formatValue(environmentValue),
    effective: projectSource !== "project" && environmentSet,
    set: environmentSet,
  });
  layers.push({
    key: "built-in",
    label: "Built-in default",
    value: formatValue(builtIn),
    effective: projectSource !== "project" && !environmentSet,
    set: true,
  });
  return layers;
}

export type SettingInheritanceState = "inherited" | "overridden" | "mixed";

/**
 * A small indicator beside a row's title that opens a top-down view of where
 * the setting's value comes from on each selected target. It sits inline so
 * narrowing to a project does not add a caption line to every row.
 */
export function SettingInheritance({
  state,
  summary,
  targets,
  environmentSettingsById,
  keys,
}: {
  state: SettingInheritanceState;
  summary: string;
  targets: readonly ScopedSettingsTarget[];
  environmentSettingsById: ReadonlyMap<string, ServerSettings>;
  keys: readonly (keyof ServerSettings)[];
}) {
  const key = keys[0];
  if (!key || targets.length === 0) return null;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`${summary}. Show where this value comes from`}
                  className={cn(
                    "[--control-icon-color:currentColor]",
                    state === "overridden"
                      ? "text-primary hover:text-primary"
                      : state === "mixed"
                        ? "text-warning hover:text-warning"
                        : "text-muted-foreground/70 hover:text-foreground",
                  )}
                />
              }
            />
          }
        >
          <LayersIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{summary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverTitle className="text-sm">Where this value comes from</PopoverTitle>
        <div className="mt-3 flex flex-col gap-4">
          {targets.map((target) => {
            const environmentSettings = environmentSettingsById.get(target.environmentId);
            if (!environmentSettings) return null;
            const layers = settingInheritanceLayers(target, environmentSettings, key);
            return (
              <div key={`${target.environmentId}:${target.projectId ?? ""}`}>
                {targets.length > 1 ? (
                  <div className="mb-1.5 truncate text-xs font-medium text-foreground">
                    {target.label}
                  </div>
                ) : null}
                <ol className="relative ms-2 border-s border-border">
                  {layers.map((layer) => (
                    <li key={layer.key} className="relative ps-4 pb-3 last:pb-0">
                      <span
                        aria-hidden
                        className={cn(
                          "absolute -start-[5px] top-1.5 size-2.5 rounded-full border-2 border-background",
                          layer.effective
                            ? "bg-primary"
                            : layer.set
                              ? "bg-muted-foreground/60"
                              : "bg-border",
                        )}
                      />
                      <div className="flex items-baseline justify-between gap-3">
                        <span
                          className={cn(
                            "text-xs",
                            layer.effective
                              ? "font-medium text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {/* The heading already names the environment when several are listed. */}
                          {targets.length > 1 && layer.key === "environment"
                            ? "Environment"
                            : layer.label}
                        </span>
                        <span
                          className={cn(
                            "flex items-center gap-1 text-xs tabular-nums",
                            layer.effective ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {layer.value}
                          {layer.effective ? <CheckIcon className="size-3 text-primary" /> : null}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
