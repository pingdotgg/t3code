import type { ReactNode } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_CODE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PROMPT_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PROMPT_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { isMacPlatform } from "../../lib/utils";
import { Input } from "../ui/input";
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  resolveDefaultFamilyLabel,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../../appearanceFonts";
import { AdvancedSettings } from "./AdvancedSettings";
import { useTheme } from "../../hooks/useTheme";
import { getThemeDefinition, resolveThemeHalf } from "../../themePalette";
import {
  CodeFontPreview,
  PromptFontPreview,
  ReplyFontPreview,
  TerminalFontPreview,
} from "./SettingsFontPreviews";
import { discoverInstalledFonts, FontFamilyPicker, useFontEnumeration } from "./FontFamilyPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import {
  isAdvancedTypographyTarget,
  revealSettingsSearchTarget,
  useSearchableSetting,
} from "./settingsSearch";

let fontDefaultFamilies: { readonly sans: string | null; readonly code: string | null } | undefined;

function resolveFontDefaultFamilies() {
  if (fontDefaultFamilies !== undefined) return fontDefaultFamilies;
  const families = {
    sans: resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ?? null,
    code: resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ?? null,
  };
  if (document.fonts.status === "loaded") fontDefaultFamilies = families;
  return families;
}

function useFontDefaultFamilies() {
  const gt = useGT();
  const settings = useScopedSettings();
  const { theme, themeHalves, resolvedTheme } = useTheme();
  const absolutely =
    getThemeDefinition(resolveThemeHalf(theme, themeHalves, resolvedTheme))?.typography ===
    "absolutely";
  const [systemDefaults] = useState(resolveFontDefaultFamilies);
  const defaults = {
    sans: absolutely ? "DM Sans" : systemDefaults.sans,
    code: absolutely ? "JetBrains Mono" : systemDefaults.code,
  };
  const sans = defaults.sans ?? gt("System default");
  return {
    sans,
    code: defaults.code ?? gt("System monospace"),
    interfaceFamily: settings.fontFamilySans.trim() || sans,
  };
}

function InterfaceFontRow({ preview }: { preview?: ReactNode }) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("interface-font")}
      resetLabel={gt("Reset interface font to default")}
      description={gt("Menus, controls, and user messages.")}
      defaultFamily={defaults.sans}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilySans}
      value={settings.fontFamilySans}
      onValueChange={(fontFamilySans) => updateSettings({ fontFamilySans })}
      onReset={() =>
        updateSettings({
          fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
          fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        })
      }
      size={{
        label: gt("Interface font size"),
        min: MIN_INTERFACE_FONT_SIZE,
        max: MAX_INTERFACE_FONT_SIZE,
        value: settings.fontSizeInterface,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        onChange: (fontSizeInterface) => updateSettings({ fontSizeInterface }),
      }}
      {...(preview !== undefined ? { preview } : {})}
    />
  );
}

function ReplyFontRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  const { theme, themeHalves, resolvedTheme } = useTheme();
  const typography = getThemeDefinition(
    resolveThemeHalf(theme, themeHalves, resolvedTheme),
  )?.typography;
  const defaultFamily = typography === "absolutely" ? "Source Serif 4" : defaults.interfaceFamily;
  return (
    <FontFamilySettingsRow
      {...searchableSetting("reply-font")}
      resetLabel={gt("Reset reply font to default")}
      description={gt("Agent replies. Leave blank to follow the theme.")}
      defaultFamily={defaultFamily}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyReply}
      value={settings.fontFamilyReply}
      onValueChange={(fontFamilyReply) => updateSettings({ fontFamilyReply })}
      onReset={() => updateSettings({ fontFamilyReply: DEFAULT_UNIFIED_SETTINGS.fontFamilyReply })}
      preview={<ReplyFontPreview />}
    />
  );
}

function PromptFontRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("prompt-font")}
      resetLabel={gt("Reset prompt font to default")}
      description={gt("Only the box you write prompts in. Mono works well here.")}
      defaultFamily={defaults.interfaceFamily}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer}
      value={settings.fontFamilyComposer}
      onValueChange={(fontFamilyComposer) => updateSettings({ fontFamilyComposer })}
      onReset={() =>
        updateSettings({
          fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
          fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        })
      }
      size={{
        label: gt("Prompt font size"),
        min: MIN_PROMPT_FONT_SIZE,
        max: MAX_PROMPT_FONT_SIZE,
        value: settings.fontSizePrompt,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        onChange: (fontSizePrompt) => updateSettings({ fontSizePrompt }),
      }}
      preview={<PromptFontPreview />}
    />
  );
}

function CodeFontRow({
  title,
  resetLabel,
  description,
  preview,
}: {
  title?: string;
  resetLabel?: string;
  description?: string;
  preview?: ReactNode;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("code-font")}
      {...(title !== undefined ? { title } : {})}
      resetLabel={resetLabel ?? gt("Reset code font to default")}
      description={description ?? gt("Code blocks, diffs, and file previews.")}
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyCode}
      value={settings.fontFamilyCode}
      onValueChange={(fontFamilyCode) => updateSettings({ fontFamilyCode })}
      onReset={() =>
        updateSettings({
          fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
          fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        })
      }
      requireMonospace
      size={{
        label: gt("Code font size"),
        min: MIN_CODE_FONT_SIZE,
        max: MAX_CODE_FONT_SIZE,
        value: settings.fontSizeCode,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        onChange: (fontSizeCode) => updateSettings({ fontSizeCode }),
      }}
      preview={preview ?? <CodeFontPreview />}
    />
  );
}

function TerminalFontRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("terminal-font")}
      resetLabel={gt("Reset terminal font to default")}
      description={gt("Terminal output, independent from code blocks and diffs.")}
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal}
      value={settings.fontFamilyTerminal}
      onValueChange={(fontFamilyTerminal) => updateSettings({ fontFamilyTerminal })}
      onReset={() =>
        updateSettings({
          fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
          fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        })
      }
      requireMonospace
      size={{
        label: gt("Terminal font size"),
        min: MIN_TERMINAL_FONT_SIZE,
        max: MAX_TERMINAL_FONT_SIZE,
        value: settings.fontSizeTerminal,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        onChange: (fontSizeTerminal) => updateSettings({ fontSizeTerminal }),
      }}
      preview={
        <TerminalFontPreview
          family={resolveTerminalFontPreference({
            advanced: true,
            code: settings.fontFamilyCode,
            terminal: settings.fontFamilyTerminal,
          })}
          size={settings.fontSizeTerminal}
        />
      }
    />
  );
}

function FontSmoothingRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!isMacPlatform(navigator.platform)) return null;
  return (
    <SettingsRow
      {...searchableSetting("font-smoothing")}
      description={gt("Use thinner grayscale text smoothing instead of the macOS default.")}
      resetAction={
        settings.fontSmoothing !== DEFAULT_UNIFIED_SETTINGS.fontSmoothing ? (
          <SettingResetButton
            ariaLabel={gt("Reset font smoothing to default")}
            onClick={() =>
              updateSettings({ fontSmoothing: DEFAULT_UNIFIED_SETTINGS.fontSmoothing })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.fontSmoothing}
          onCheckedChange={(checked) => updateSettings({ fontSmoothing: Boolean(checked) })}
          aria-label={gt("Font smoothing")}
        />
      }
    />
  );
}

function WordWrapRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("word-wrap")}
      description={gt("Wrap long lines in code blocks, diffs, and file previews by default.")}
      resetAction={
        settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
          <SettingResetButton
            ariaLabel={gt("Reset word wrapping to default")}
            onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wordWrap}
          onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
          aria-label={gt("Wrap code, diffs, and file previews by default")}
        />
      }
    />
  );
}

function FontSettingsGroup() {
  return (
    <>
      <InterfaceFontRow />
      <ReplyFontRow />
      <PromptFontRow />
      <CodeFontRow />
      <TerminalFontRow />
    </>
  );
}

function SeparateFontsRow({
  checked,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  return (
    <SettingsRow
      {...searchableSetting("separate-fonts")}
      description={gt(
        "Set the prompt, code, and terminal fonts separately instead of one monospace font.",
      )}
      control={
        <Switch
          checked={checked}
          onCheckedChange={(next) => onCheckedChange(Boolean(next))}
          aria-label={gt("Separate fonts")}
        />
      }
    />
  );
}

function SimpleFontRows() {
  const gt = useGT();
  const settings = useScopedSettings();
  return (
    <>
      <InterfaceFontRow preview={<PromptFontPreview />} />
      <ReplyFontRow />
      <CodeFontRow
        title={gt("Monospace font")}
        resetLabel={gt("Reset monospace font to default")}
        description={gt("Code blocks, diffs, file previews, and the terminal.")}
        preview={
          <>
            <CodeFontPreview />
            <TerminalFontPreview
              family={resolveTerminalFontPreference({
                advanced: false,
                code: settings.fontFamilyCode,
                terminal: settings.fontFamilyTerminal,
              })}
              size={resolveTerminalFontSizePreference({
                advanced: false,
                code: settings.fontSizeCode,
                terminal: settings.fontSizeTerminal,
              })}
            />
          </>
        }
      />
    </>
  );
}

export function TypographySection() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const [advanced, setAdvanced] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  // A deep link or history step must persist the flag too: the terminal reads it, so advanced
  // rows without it would make terminal font edits do nothing. The rows follow the target
  // directly so its row mounts in the first commit; the target clears once handled.
  const searchTargetId = useSettingsSearchTargetId();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the advanced typography flag to localStorage when a search target needs it
  useEffect(() => {
    if (searchTargetId !== null) revealSettingsSearchTarget(searchTargetId);
  }, [searchTargetId]);
  const showAdvanced =
    advanced || (searchTargetId !== null && isAdvancedTypographyTarget(searchTargetId));
  return (
    <SettingsSection id="typography" title={gt("Typography")}>
      {showAdvanced ? <FontSettingsGroup /> : <SimpleFontRows />}
      <WordWrapRow />
      <AdvancedSettings
        targetIds={[searchableSetting("separate-fonts").id, searchableSetting("font-smoothing").id]}
      >
        <SeparateFontsRow checked={showAdvanced} onCheckedChange={setAdvanced} />
        <FontSmoothingRow />
      </AdvancedSettings>
    </SettingsSection>
  );
}

function FontFamilySettingsRow({
  id,
  title,
  resetLabel,
  description,
  defaultFamily,
  defaultValue,
  preview,
  value,
  onValueChange,
  onReset,
  requireMonospace = false,
  size,
}: {
  id?: string;
  title: string;
  resetLabel: string;
  description: string;
  defaultFamily: string;
  defaultValue: string;
  preview?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  onReset: () => void;
  requireMonospace?: boolean;
  size?: {
    label: string;
    min: number;
    max: number;
    value: number;
    defaultValue: number;
    onChange: (v: number) => void;
  };
}) {
  const gt = useGT();
  const trimmed = value.trim();
  const [draft, setDraft] = useState(value);
  const [draftSettled, setDraftSettled] = useState(true);
  // Each pending commit remembers the value it was typed against, so one that outlives
  // an external change (hydration, reset, picker selection) drops its stale draft.
  const commitTimerRef = useRef<{ readonly id: number; readonly value: string } | null>(null);
  const cancelPendingCommit = () => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current.id);
    commitTimerRef.current = null;
  };
  // Bumped on every external value change, so a pending commit typed before one never lands,
  // even if the value has since changed back to what it was typed against.
  const [adopted, setAdopted] = useState({ value, generation: 0 });
  if (adopted.value !== value) {
    setAdopted({ value, generation: adopted.generation + 1 });
    setDraft(value);
    setDraftSettled(true);
  }
  const readAdoptedGeneration = useEffectEvent(() => adopted.generation);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending commit timer on unmount
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current.id);
    },
    [],
  );
  const acceptsFamily = (candidate: string) =>
    isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamily(candidate));
  const commitDraft = (next: string) => {
    setDraftSettled(true);
    if (next.trim().length === 0 || acceptsFamily(next)) {
      onValueChange(next);
    }
  };
  const flushDraft = () => {
    const pending = commitTimerRef.current;
    cancelPendingCommit();
    if (pending !== null && pending.value === value) commitDraft(draft);
  };
  const draftTrimmed = draft.trim();
  const draftPending = draftSettled && draftTrimmed.length > 0 && draftTrimmed !== trimmed;
  const resetToDefault = () => {
    cancelPendingCommit();
    setDraft(defaultValue);
    setDraftSettled(true);
    onReset();
  };
  const resetAction =
    value !== defaultValue || (size !== undefined && size.value !== size.defaultValue) ? (
      <SettingResetButton ariaLabel={resetLabel} onClick={resetToDefault} />
    ) : null;
  const fontEnumeration = useFontEnumeration();
  const [inputFocused, setInputFocused] = useState(false);
  const familyControl =
    fontEnumeration.status === "granted" ? (
      <FontFamilyPicker
        ariaLabel={gt("{title} family", { title })}
        defaultFamily={defaultFamily}
        selectedFamily={trimmed}
        requireMonospace={requireMonospace}
        initialOpen={inputFocused}
        onSelect={onValueChange}
      />
    ) : (
      <Input
        size="sm"
        aria-label={gt("{title} family", { title })}
        aria-invalid={draftPending || undefined}
        autoCapitalize="off"
        autoComplete="off"
        className="min-w-0 flex-1"
        maxLength={200}
        onFocus={() => {
          setInputFocused(true);
          discoverInstalledFonts();
        }}
        onBlur={() => {
          setInputFocused(false);
          flushDraft();
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          setDraftSettled(false);
          cancelPendingCommit();
          const typedAgainst = value;
          const typedInGeneration = adopted.generation;
          commitTimerRef.current = {
            id: window.setTimeout(() => {
              commitTimerRef.current = null;
              if (readAdoptedGeneration() === typedInGeneration) commitDraft(next);
            }, 400),
            value: typedAgainst,
          };
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") flushDraft();
          if (event.key === "Escape") {
            // Discard uncommitted typing without closing the settings page,
            // which is what an unhandled Escape does.
            event.preventDefault();
            event.stopPropagation();
            cancelPendingCommit();
            setDraft(value);
            setDraftSettled(true);
          }
        }}
        placeholder={defaultFamily}
        spellCheck={false}
        value={draft}
      />
    );
  const control = (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto @min-[32rem]/settings-row:flex-nowrap">
      <div className="min-w-36 flex-1 sm:w-44 sm:flex-none">{familyControl}</div>
      {size ? (
        <Select
          value={String(size.value)}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            const parsed = Number(next);
            if (Number.isInteger(parsed) && parsed >= size.min && parsed <= size.max) {
              size.onChange(parsed);
            }
          }}
        >
          <SelectTrigger size="sm" className="w-22 shrink-0" aria-label={size.label}>
            <SelectValue>{size.value} px</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Array.from({ length: size.max - size.min + 1 }, (_, index) => size.min + index).map(
              (px) => (
                <SelectItem hideIndicator key={px} value={String(px)}>
                  {px} px
                </SelectItem>
              ),
            )}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  );
  return (
    <SettingsRow
      {...(id !== undefined ? { id } : {})}
      title={title}
      description={description}
      resetAction={resetAction}
      control={control}
    >
      {preview}
    </SettingsRow>
  );
}
