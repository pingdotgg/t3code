import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { DEFAULT_UNIFIED_SETTINGS, SidebarVariant } from "@t3tools/contracts/settings";
import { CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { RadioGroup } from "../ui/radio-group";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const OPTIONS: Record<SidebarVariant, { label: string; description: string }> = {
  default: {
    label: "Default",
    description: "T3 Code's sidebar. The settings below shape it.",
  },
  detailed: {
    label: "Detailed",
    description: "Threads stay in their project. Workers nest under them. Answer on the row.",
  },
  slim: {
    label: "Slim",
    description: "One line per thread in project folders. Workers fold to a count.",
  },
};

function PreviewLine(props: { className?: string }) {
  return <span className={cn("h-0.5 rounded-full bg-muted-foreground/40", props.className)} />;
}

function PreviewRows({ variant }: { variant: SidebarVariant }) {
  switch (variant) {
    case "default":
      return (
        <>
          {["w-4/5", "w-3/5"].map((width) => (
            <span key={width} className="flex flex-col gap-0.5 rounded-sm bg-foreground/5 p-1">
              <PreviewLine className="w-2/5" />
              <PreviewLine className={width} />
              <PreviewLine className="w-1/2" />
            </span>
          ))}
          <PreviewLine className="mt-auto w-1/3" />
        </>
      );
    case "detailed":
      return (
        <>
          <PreviewLine className="w-1/2" />
          {["w-4/5", "w-3/5"].map((width, index) => (
            <span key={width} className="relative flex flex-col gap-0.5 ps-2">
              <span
                className={cn(
                  "absolute inset-y-0 left-0 w-0.5 rounded-full",
                  index === 0 ? "bg-warning" : "bg-info",
                )}
              />
              <PreviewLine className={width} />
              <PreviewLine className="w-1/2" />
            </span>
          ))}
          <span className="flex h-0.5 gap-px ps-2">
            <span className="flex-1 rounded-full bg-info" />
            <span className="flex-1 rounded-full bg-info" />
            <span className="flex-1 rounded-full bg-warning" />
          </span>
        </>
      );
    case "slim":
      return (
        <>
          <PreviewLine className="w-1/2" />
          {["w-4/5", "w-2/3", "w-3/4", "w-3/5"].map((width, index) => (
            <span key={width} className="flex items-center gap-1 ps-1">
              <span
                className={cn(
                  "size-1 shrink-0 rounded-full",
                  index === 0 ? "bg-info" : index === 1 ? "bg-warning" : "bg-muted-foreground/40",
                )}
              />
              <PreviewLine className={width} />
            </span>
          ))}
        </>
      );
  }
}

/** The sidebar variant picker; it applies at once, and the stored Boring settings stay for Default. */
export function SidebarVariantRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("sidebar-variant")}
      description="How the sidebar lists threads. Detailed and Slim are in beta, and keep threads in place when their state changes."
      resetAction={
        settings.sidebarVariant !== DEFAULT_UNIFIED_SETTINGS.sidebarVariant ? (
          <SettingResetButton
            label="sidebar layout"
            onClick={() =>
              updateSettings({ sidebarVariant: DEFAULT_UNIFIED_SETTINGS.sidebarVariant })
            }
          />
        ) : null
      }
    >
      <RadioGroup
        aria-label="Sidebar layout"
        value={settings.sidebarVariant}
        onValueChange={(value) => updateSettings({ sidebarVariant: value as SidebarVariant })}
        className="mt-3 mb-2 grid grid-cols-1 @min-[32rem]/settings-row:grid-cols-3"
      >
        {SidebarVariant.literals.map((variant) => (
          <RadioPrimitive.Root
            key={variant}
            value={variant}
            className="flex cursor-pointer flex-col gap-2 rounded-lg bg-card p-2 text-left outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
          >
            <span
              aria-hidden
              className="flex h-14 flex-col gap-1 overflow-hidden rounded-md bg-sidebar p-1.5"
            >
              <PreviewRows variant={variant} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex h-5 items-center justify-between gap-2 text-sm font-medium text-foreground">
                {OPTIONS[variant].label}
                <RadioPrimitive.Indicator
                  aria-hidden
                  className="grid size-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                >
                  <CheckIcon className="size-3 shrink-0" />
                </RadioPrimitive.Indicator>
              </span>
              <span className="text-xs text-muted-foreground">{OPTIONS[variant].description}</span>
            </span>
          </RadioPrimitive.Root>
        ))}
      </RadioGroup>
    </SettingsRow>
  );
}
