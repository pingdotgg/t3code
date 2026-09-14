import { useRef, useState } from "react";
import { EXTERNAL_TERMINALS, ExternalTerminalId } from "@t3tools/contracts";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ExternalTerminalSetting() {
  const terminal = useClientSettings((settings) => settings.externalTerminal);
  const hydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const bridge = window.desktopBridge;
  if (!bridge?.openTerminal) return null;
  const platform = bridge.getClientPlatform?.() ?? "";
  const options = EXTERNAL_TERMINALS.filter(({ platforms }) => platforms.includes(platform));
  const selectTerminal = async (selected: ExternalTerminalId) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await bridge.requestTerminalPermission?.(selected);
      updateSettings({ externalTerminal: selected });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not prepare the terminal. Select it again to retry.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return (
    <SettingsSection id="terminal" title="Terminal">
      <SettingsRow
        {...searchableSetting("external-terminal")}
        title="Terminal app"
        description="Open the project or worktree directory from the Open menu. Remote environments connect over SSH using this machine’s SSH configuration."
        control={
          <div className="flex items-center gap-2">
            <Select
              value={terminal}
              disabled={!hydrated || pending}
              onValueChange={(value) => {
                const selected = ExternalTerminalId.literals.find((id) => id === value);
                if (selected) void selectTerminal(selected);
              }}
            >
              <SelectTrigger className="w-44" aria-label="Terminal app">
                <SelectValue>
                  {EXTERNAL_TERMINALS.find(({ id }) => id === terminal)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {options.map(({ id, label }) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <SettingResetButton
              label="terminal app"
              disabled={!hydrated || pending || terminal === "system"}
              onClick={() => void selectTerminal("system")}
            />
          </div>
        }
      >
        {pending && (
          <p role="status" className="pb-2 text-sm text-muted-foreground">
            Preparing terminal… Respond to any macOS permission prompt.
          </p>
        )}
        {error && (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
