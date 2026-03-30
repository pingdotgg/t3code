import { CheckIcon } from "lucide-react";
import { useCallback, useRef } from "react";
import type { ColorMode } from "@t3tools/contracts/settings";
import { useAppearance } from "../../hooks/useAppearance";
import {
  ACCENT_PRESETS,
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  type ThemeDefinition,
  type ThemeTokenMap,
} from "../../lib/themes";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./SettingsPanels";

// ── Constants ────────────────────────────────────────────────────

const COLOR_MODE_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

// ── Swatch preview ──────────────────────────────────────────────

/** Render small color dots showing what the theme overrides. */
function ThemeSwatch({ theme }: { theme: ThemeDefinition }) {
  // Show the tokens the theme actually overrides (merge light + dark for preview)
  const overrideTokens = Object.keys({ ...theme.light, ...theme.dark }) as Array<
    keyof ThemeTokenMap
  >;

  if (overrideTokens.length === 0) {
    // Default theme — show placeholder dots
    return (
      <div className="flex gap-1.5">
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} className="size-3 rounded-full border border-border/40 bg-muted" />
        ))}
      </div>
    );
  }

  // For display, prefer light-mode values (more vivid), fall back to dark
  const displayTokens = overrideTokens.filter((t) => !t.endsWith("-foreground")).slice(0, 5);

  return (
    <div className="flex gap-1.5">
      {displayTokens.map((token) => {
        const color = theme.light[token] ?? theme.dark[token];
        return color ? (
          <span
            key={token}
            className="size-3 rounded-full border border-border/40"
            style={{ background: color }}
          />
        ) : (
          <span key={token} className="size-3 rounded-full border border-border/40 bg-muted" />
        );
      })}
    </div>
  );
}

// ── Theme card ───────────────────────────────────────────────────

function ThemeCard({
  theme,
  isSelected,
  onSelect,
}: {
  theme: ThemeDefinition;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      className={cn(
        "flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors",
        isSelected
          ? "border-primary bg-primary/5 ring-2 ring-primary/30"
          : "border-border bg-card hover:border-primary/40",
      )}
      onClick={onSelect}
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-sm font-medium text-foreground">{theme.name}</span>
        {isSelected ? <CheckIcon className="size-4 text-primary" /> : null}
      </div>
      <p className="text-xs text-muted-foreground">{theme.description}</p>
      <ThemeSwatch theme={theme} />
    </button>
  );
}

// ── Accent preset circle ─────────────────────────────────────────

function AccentCircle({
  hue,
  isSelected,
  label,
  onClick,
}: {
  hue: number;
  isSelected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full border-2 transition-shadow",
        isSelected
          ? "border-primary ring-2 ring-primary/30"
          : "border-border hover:border-primary/40",
      )}
      style={{ background: `oklch(0.55 0.2 ${hue})` }}
      onClick={onClick}
    >
      {isSelected ? <CheckIcon className="size-3.5 text-white drop-shadow-sm" /> : null}
    </button>
  );
}

// ── Main panel ───────────────────────────────────────────────────

export function AppearanceSettingsPanel() {
  const { colorMode, activeTheme, accentHue, setColorMode, setThemeId, setAccentHue } =
    useAppearance();

  const colorInputRef = useRef<HTMLInputElement>(null);

  const handleCustomAccentChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Convert hex to approximate oklch hue via HSL
      const hex = e.target.value;
      const hue = hexToApproxHue(hex);
      setAccentHue(hue);
    },
    [setAccentHue],
  );

  return (
    <SettingsPageContainer>
      {/* Section 1: Color Mode */}
      <SettingsSection title="Color Mode">
        <SettingsRow
          title="Mode"
          description="Choose how T3 Code looks across the app."
          resetAction={
            colorMode !== "system" ? (
              <SettingResetButton label="color mode" onClick={() => setColorMode("system")} />
            ) : null
          }
          control={
            <Select
              value={colorMode}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setColorMode(value as ColorMode);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Color mode preference">
                <SelectValue>
                  {COLOR_MODE_OPTIONS.find((o) => o.value === colorMode)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {COLOR_MODE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      {/* Section 2: Theme */}
      <SettingsSection title="Theme">
        <div className="px-4 py-4 sm:px-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {BUILT_IN_THEMES.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                isSelected={activeTheme.id === theme.id}
                onSelect={() => setThemeId(theme.id)}
              />
            ))}
          </div>
          {activeTheme.id !== DEFAULT_THEME_ID ? (
            <div className="mt-3 flex justify-end">
              <SettingResetButton
                label="appearance theme"
                onClick={() => setThemeId(DEFAULT_THEME_ID)}
              />
            </div>
          ) : null}
        </div>
      </SettingsSection>

      {/* Section 3: Accent Color */}
      <SettingsSection title="Accent Color">
        <div className="px-4 py-4 sm:px-5">
          <p className="mb-3 text-xs text-muted-foreground">
            Override the primary color across the app.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* Default pill */}
            <button
              type="button"
              aria-pressed={accentHue === null}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                accentHue === null
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40",
              )}
              onClick={() => setAccentHue(null)}
            >
              Default
            </button>

            {/* Preset circles */}
            {ACCENT_PRESETS.map((preset) => (
              <AccentCircle
                key={preset.name}
                hue={preset.hue}
                isSelected={accentHue === preset.hue}
                label={preset.name}
                onClick={() => setAccentHue(preset.hue)}
              />
            ))}

            {/* Custom color picker */}
            <Button
              variant="outline"
              size="xs"
              className="relative overflow-hidden"
              onClick={() => colorInputRef.current?.click()}
            >
              Custom
              <input
                ref={colorInputRef}
                type="color"
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={handleCustomAccentChange}
                tabIndex={-1}
              />
            </Button>
          </div>

          {accentHue !== null ? (
            <div className="mt-3 flex justify-end">
              <SettingResetButton label="accent color" onClick={() => setAccentHue(null)} />
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// ── Utilities ────────────────────────────────────────────────────

/**
 * Convert a hex color string to an approximate hue (0-360).
 * Good enough for a color-picker UX — exact oklch conversion isn't needed.
 */
function hexToApproxHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;
  return hue;
}
