import { DEFAULT_UNIFIED_SETTINGS } from "@lathe/contracts/settings";
import { useEffect } from "react";

import { previewSyntaxTheme } from "../../lib/syntaxThemePreview";
import { SYNTAX_THEME_OPTIONS, isSyntaxTheme } from "../../lib/syntaxThemes";
import ChatMarkdown from "../ChatMarkdown";
import { SyntaxThemeSwatches } from "../SyntaxThemeSwatches";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const PREVIEW_MARKDOWN = [
  "```ts",
  "// Threads untouched for a day render as stale.",
  "const STALE_AFTER_MS = 1000 * 60 * 60 * 24;",
  "",
  "export function isStale(thread: ThreadSummary, now = Date.now()): boolean {",
  "  if (thread.pinned) return false;",
  "  return now - thread.updatedAt > STALE_AFTER_MS;",
  "}",
  "",
  "const label = `${threads.filter(isStale).length} stale threads`;",
  "```",
].join("\n");

/** Appearance row that picks the token colors for chat code, files, and diffs. */
export function SyntaxThemeRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  // Leaving the page mid-browse must not strand a preview.
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- clears the global syntax theme preview on unmount so leaving mid-browse does not strand it
  useEffect(() => () => previewSyntaxTheme(null), []);
  const selected =
    SYNTAX_THEME_OPTIONS.find((option) => option.id === settings.syntaxTheme) ??
    SYNTAX_THEME_OPTIONS[0]!;

  return (
    <SettingsRow
      {...searchableSetting("syntax-theme")}
      description="Token colors for code in chat, the Files view, and diffs. Each theme follows light and dark mode."
      resetAction={
        settings.syntaxTheme !== DEFAULT_UNIFIED_SETTINGS.syntaxTheme ? (
          <SettingResetButton
            ariaLabel="Reset syntax theme to default"
            onClick={() => updateSettings({ syntaxTheme: DEFAULT_UNIFIED_SETTINGS.syntaxTheme })}
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-52">
          <Select
            value={settings.syntaxTheme}
            onValueChange={(value) => {
              previewSyntaxTheme(null);
              if (isSyntaxTheme(value)) updateSettings({ syntaxTheme: value });
            }}
            onOpenChange={(open) => {
              if (!open) previewSyntaxTheme(null);
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Syntax theme">
              <SyntaxThemeSwatches theme={selected.id} />
              <SelectValue>{selected.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {SYNTAX_THEME_OPTIONS.map((option) => (
                <SelectItem
                  key={option.id}
                  value={option.id}
                  // Arrow keys and hover both move focus to the highlighted item.
                  onFocus={() => previewSyntaxTheme(option.id)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <SyntaxThemeSwatches theme={option.id} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">
                        {option.id === DEFAULT_UNIFIED_SETTINGS.syntaxTheme
                          ? `${option.label} (default)`
                          : option.label}
                      </span>
                      <span className="truncate text-muted-foreground text-xs">
                        {option.description}
                      </span>
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    >
      <div className="pt-1">
        <ChatMarkdown text={PREVIEW_MARKDOWN} cwd={undefined} />
      </div>
    </SettingsRow>
  );
}
