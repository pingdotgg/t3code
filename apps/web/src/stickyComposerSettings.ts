import { type CodexReasoningEffort, CODEX_REASONING_EFFORT_OPTIONS } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { Schema } from "effect";
import { useCallback } from "react";
import { useLocalStorage } from "./hooks/useLocalStorage";

const STICKY_COMPOSER_SETTINGS_STORAGE_KEY = "t3code:sticky-composer-settings:v1";

const StickyComposerSettingsSchema = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  codexFastMode: Schema.Boolean,
});

export type StickyComposerSettings = typeof StickyComposerSettingsSchema.Type;

const DEFAULT_STICKY_COMPOSER_SETTINGS: StickyComposerSettings = {
  model: null,
  effort: null,
  codexFastMode: false,
};

function normalizeStickyComposerSettings(
  value: Partial<StickyComposerSettings> | StickyComposerSettings,
): StickyComposerSettings {
  const effort = value.effort;
  return {
    model: normalizeModelSlug(value.model, "codex") ?? null,
    effort:
      typeof effort === "string" &&
      (CODEX_REASONING_EFFORT_OPTIONS as readonly string[]).includes(effort)
        ? (effort as CodexReasoningEffort)
        : null,
    codexFastMode: value.codexFastMode === true,
  };
}

export function useStickyComposerSettings() {
  const [settings, setSettings] = useLocalStorage(
    STICKY_COMPOSER_SETTINGS_STORAGE_KEY,
    DEFAULT_STICKY_COMPOSER_SETTINGS,
    StickyComposerSettingsSchema,
  );

  const updateSettings = useCallback(
    (patch: Partial<StickyComposerSettings>) => {
      setSettings((previous) => normalizeStickyComposerSettings({ ...previous, ...patch }));
    },
    [setSettings],
  );

  return {
    settings,
    updateSettings,
    defaults: DEFAULT_STICKY_COMPOSER_SETTINGS,
  } as const;
}
