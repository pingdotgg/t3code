import { useMemo } from "react";
import { RefreshCwIcon } from "lucide-react";
import type { VscodeThemeSummary } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useActiveEnvironmentId } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

// Sentinel select value for "no VSCode theme — follow the app's light/dark mode".
const DEFAULT_THEME_VALUE = "__default__";

const SAMPLE_CODE = [
  "```tsx",
  "// Greet a list of users; theme preview sample.",
  "import { useState } from 'react';",
  "",
  "interface User {",
  "  id: number;",
  "  name: string;",
  "}",
  "",
  "export function Greeting({ users }: { users: User[] }) {",
  "  const [count, setCount] = useState(0);",
  "  const active = users.filter((user) => user.id > 0);",
  "  return active.length > 0 ? `Hello, ${active.length} users!` : 'No one here.';",
  "}",
  "```",
].join("\n");

function describeSource(source: VscodeThemeSummary["source"]): string {
  return source === "builtin" ? "Built-in" : "Extension";
}

export function ThemeSettingsPanel() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const environmentId = useActiveEnvironmentId();

  const {
    data: themeList,
    isPending,
    error,
    refresh,
  } = useEnvironmentQuery(
    environmentId ? serverEnvironment.themesList({ environmentId, input: {} }) : null,
  );

  const themes = useMemo(() => themeList?.themes ?? [], [themeList]);
  const selectedId = settings.codeBlockThemeId;
  const selectedTheme = selectedId
    ? (themes.find((theme) => theme.id === selectedId) ?? null)
    : null;
  // Selected an id that isn't in the catalog anymore (e.g. extension removed or
  // VSCode updated). The catalog has loaded but doesn't contain it.
  const selectedIsMissing = Boolean(selectedId) && themeList != null && selectedTheme === null;

  const selectValue = selectedId ?? DEFAULT_THEME_VALUE;
  const selectLabel = selectedId
    ? (selectedTheme?.label ?? "Unavailable theme")
    : "Default (follows light/dark)";

  const handleChange = (value: string | null) => {
    updateSettings({
      codeBlockThemeId: !value || value === DEFAULT_THEME_VALUE ? null : value,
    });
  };

  const status = error
    ? `Couldn't read VSCode themes: ${error}`
    : selectedIsMissing
      ? "The selected theme is no longer installed. Code blocks fall back to the default theme."
      : isPending && themes.length === 0
        ? "Reading installed VSCode themes…"
        : themeList != null && themes.length === 0
          ? "No VSCode themes found on this machine."
          : null;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Code Theme"
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={!environmentId || isPending}
                  onClick={refresh}
                  aria-label="Refresh installed themes"
                >
                  <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh installed themes</TooltipPopup>
          </Tooltip>
        }
      >
        <SettingsRow
          title="Syntax theme"
          description="Apply a VSCode theme's colors and background to every code block. Independent of the app's light/dark mode."
          status={status}
          resetAction={
            selectedId ? (
              <SettingResetButton
                label="syntax theme"
                onClick={() => updateSettings({ codeBlockThemeId: null })}
              />
            ) : null
          }
          control={
            <Select value={selectValue} onValueChange={handleChange}>
              <SelectTrigger className="w-full sm:w-64" aria-label="Code block syntax theme">
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={DEFAULT_THEME_VALUE}>
                  Default (follows light/dark)
                </SelectItem>
                {themes.map((theme) => (
                  <SelectItem hideIndicator key={theme.id} value={theme.id}>
                    <span className="flex w-full items-center justify-between gap-3">
                      <span className="truncate">{theme.label}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground/70">
                        {describeSource(theme.source)} · {theme.type === "dark" ? "Dark" : "Light"}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        >
          <div className="pt-3 pb-3.5">
            <p className="mb-2 text-xs text-muted-foreground/80">Preview</p>
            <ChatMarkdown text={SAMPLE_CODE} cwd={undefined} />
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
