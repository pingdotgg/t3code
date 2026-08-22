import { useMemo, useState } from "react";
import {
  DEFAULT_SUPERCOMPRESS_MIN_CHARS,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SUPERCOMPRESS_MIN_CHARS,
  MIN_SUPERCOMPRESS_MIN_CHARS,
} from "@t3tools/contracts/settings";
import { SUPERCOMPRESS_API_KEY_CONFIGURED_SENTINEL } from "@t3tools/shared/serverSettings";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const CONFIGURED_SENTINEL = SUPERCOMPRESS_API_KEY_CONFIGURED_SENTINEL;

function looksLikeSuperCompressKey(value: string): boolean {
  const key = value.trim();
  return key.startsWith("sc_") && key !== CONFIGURED_SENTINEL && !key.includes("${");
}

export function SuperCompressSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const configured = settings.supercompress.apiKey === CONFIGURED_SENTINEL;
  const [draftKey, setDraftKey] = useState("");

  const status = useMemo(() => {
    if (!settings.supercompress.enabled) return "Off";
    if (configured || looksLikeSuperCompressKey(settings.supercompress.apiKey)) {
      return "Connected";
    }
    return "Needs API key";
  }, [configured, settings.supercompress.apiKey, settings.supercompress.enabled]);

  const canReset =
    settings.supercompress.enabled !== DEFAULT_UNIFIED_SETTINGS.supercompress.enabled ||
    settings.supercompress.minChars !== DEFAULT_UNIFIED_SETTINGS.supercompress.minChars ||
    settings.supercompress.apiKey.length > 0;

  return (
    <SettingsSection title="SuperCompress">
      <SettingsRow
        {...searchableSetting("supercompress")}
        description="Compress bulky pasted context before each coding-agent turn. Your ask stays as you wrote it. Fail-open if SuperCompress is unavailable."
        resetAction={
          canReset ? (
            <SettingResetButton
              label="SuperCompress"
              onClick={() => {
                setDraftKey("");
                updateSettings({
                  supercompress: {
                    enabled: false,
                    apiKey: "",
                    minChars: DEFAULT_SUPERCOMPRESS_MIN_CHARS,
                  },
                });
              }}
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{status}</span>
            <Switch
              checked={settings.supercompress.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ supercompress: { enabled: Boolean(checked) } })
              }
              aria-label="Compress bulky context before agent turns"
            />
          </div>
        }
      />

      {settings.supercompress.enabled ? (
        <>
          <SettingsRow
            title="API key"
            description={
              <>
                Paste an <code className="text-xs">sc_…</code> key from{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://www.supercompress.dev/dashboard"
                  target="_blank"
                  rel="noreferrer"
                >
                  supercompress.dev/dashboard
                </a>
                . Stored with this environment’s server settings.
              </>
            }
            control={
              <div className="flex w-full max-w-sm flex-col gap-2 sm:items-end">
                <DraftInput
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full"
                  placeholder={configured ? "Key saved — paste to replace" : "sc_…"}
                  value={draftKey}
                  onCommit={(next) => {
                    const trimmed = next.trim();
                    setDraftKey(trimmed);
                    if (!looksLikeSuperCompressKey(trimmed)) return;
                    updateSettings({ supercompress: { apiKey: trimmed } });
                    setDraftKey("");
                  }}
                  aria-label="SuperCompress API key"
                />
                {configured ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setDraftKey("");
                      updateSettings({ supercompress: { apiKey: "" } });
                    }}
                  >
                    Clear key
                  </Button>
                ) : null}
              </div>
            }
          />

          <SettingsRow
            title="Minimum message size"
            description="Messages shorter than this stay uncompressed. Raise it if short prompts should skip SuperCompress."
            control={
              <Input
                type="number"
                inputMode="numeric"
                className="w-28 bg-background"
                min={MIN_SUPERCOMPRESS_MIN_CHARS}
                max={MAX_SUPERCOMPRESS_MIN_CHARS}
                value={settings.supercompress.minChars}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (!Number.isFinite(next)) return;
                  const clamped = Math.min(
                    MAX_SUPERCOMPRESS_MIN_CHARS,
                    Math.max(MIN_SUPERCOMPRESS_MIN_CHARS, Math.round(next)),
                  );
                  updateSettings({ supercompress: { minChars: clamped } });
                }}
                aria-label="SuperCompress minimum message size in characters"
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
