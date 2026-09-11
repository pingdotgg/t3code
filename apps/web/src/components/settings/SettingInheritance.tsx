import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import * as Equal from "effect/Equal";

import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
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
    label: target.projectId === null ? target.label : target.label.split(" · ")[0]!,
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

/**
 * Status text that opens a top-down view of where a setting's value comes
 * from on each selected target. Replaces the plain "Inherited"/"Overridden"
 * caption when there is a hierarchy to show.
 */
export function SettingInheritance({
  summary,
  targets,
  environmentSettingsById,
  keys,
}: {
  summary: string;
  targets: readonly ScopedSettingsTarget[];
  environmentSettingsById: ReadonlyMap<string, ServerSettings>;
  keys: readonly (keyof ServerSettings)[];
}) {
  const key = keys[0];
  if (!key || targets.length === 0) return <>{summary}</>;
  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex items-center gap-1 rounded text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        aria-label="Show where this value comes from"
      >
        {summary}
        <ChevronDownIcon className="size-3" />
      </PopoverTrigger>
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
                          {layer.label}
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
