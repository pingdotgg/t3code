import { useEffect, useState } from "react";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type VoiceSettings as VoiceSettingsValue,
} from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSession, readPreparedConnection } from "../../state/session";
import { requestVoiceSettings } from "../../voice/ui/brokerPort";
import { useVoiceFastCommands } from "../../voice/ui/preferences";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function VoiceEnvironmentSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const [settings, setSettings] = useState<VoiceSettingsValue | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const prepared = readPreparedConnection(environmentId);
  const session = appAtomRegistry.get(environmentSession.sessionStateValueAtom(environmentId));
  const canManage = session?.scopes?.includes(AuthAccessWriteScope) === true;
  useEffect(() => {
    let active = true;
    if (prepared && canManage) {
      void requestVoiceSettings(prepared).then(
        (value) => {
          if (active) setSettings(value);
        },
        () => {
          if (active)
            setError(
              "Could not load voice settings. This environment may need a newer Fork Nightly build.",
            );
        },
      );
    }
    return () => {
      active = false;
    };
  }, [prepared, canManage]);

  async function save(removeKey = false) {
    if (!prepared || !settings) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await requestVoiceSettings(prepared, {
        liveModel: settings.liveModel.trim(),
        backendModel: settings.backendModel.trim(),
        ...(removeKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setSettings(result);
      setApiKey("");
      setSaved(true);
    } catch {
      setError(
        "Could not save voice settings. Check your connection and administrator access, then try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">
        Administrator access to this environment is required to configure voice.
      </p>
    );
  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!settings && !error && (
        <p className="text-sm text-muted-foreground">Loading voice settings…</p>
      )}
      {settings && (
        <>
          <SettingsRow
            title="OpenAI API key"
            description={
              settings.keyConfigured
                ? "Key configured. Leave blank to keep it, or enter a replacement."
                : "Add a key with GPT Live access to enable voice. OpenAI API usage is billed to this key."
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              aria-label="OpenAI API key"
              value={apiKey}
              disabled={busy}
              onChange={(event) => {
                setApiKey(event.target.value);
                setSaved(false);
              }}
              placeholder={settings.keyConfigured ? "Replace key" : "Enter API key"}
            />
          </SettingsRow>
          <SettingsRow
            title="Speech model"
            description="Model used to listen and speak. Applies to the next voice connection."
          >
            <Input
              aria-label="Speech model"
              value={settings.liveModel}
              disabled={busy}
              onChange={(event) => {
                setSettings({ ...settings, liveModel: event.target.value });
                setSaved(false);
              }}
            />
          </SettingsRow>
          <SettingsRow
            title="Reasoning model"
            description="Handles ambiguous commands and more involved tasks."
          >
            <Input
              aria-label="Reasoning model"
              value={settings.backendModel}
              disabled={busy}
              onChange={(event) => {
                setSettings({ ...settings, backendModel: event.target.value });
                setSaved(false);
              }}
            />
          </SettingsRow>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !settings.liveModel.trim() || !settings.backendModel.trim()}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save voice settings"}
            </Button>
            {settings.keyConfigured && (
              <Button variant="outline" disabled={busy} onClick={() => void save(true)}>
                Remove key and disable voice
              </Button>
            )}
          </div>
          {saved && (
            <div role="status" className="space-y-2 text-sm text-muted-foreground">
              <p>
                Saved. Reload the app to refresh voice availability. Model changes apply to your
                next voice connection.
              </p>
              <Button variant="outline" onClick={() => window.location.reload()}>
                Reload app
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function VoiceSettingsSection() {
  const { environment } = useSettingsScope();
  const [fastCommands, setFastCommands] = useVoiceFastCommands();
  return (
    <SettingsSection id="voice" title="Voice">
      <SettingsRow
        title="Fast commands"
        description="Open exact thread matches and create empty drafts quickly. More nuanced requests still use the reasoning model. This preference applies on this device."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={fastCommands}
            onChange={(event) => setFastCommands(event.target.checked)}
          />
          Use fast commands
        </label>
      </SettingsRow>
      {environment ? (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            Voice configuration for {environment.label}. Applies to this entire environment.
          </p>
          <VoiceEnvironmentSettings
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a connected environment to configure voice.
        </p>
      )}
    </SettingsSection>
  );
}
