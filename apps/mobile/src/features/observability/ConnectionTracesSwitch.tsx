import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";

import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { setConnectionTracesEnabled } from "./diagnosticsSetting";
import { resolveTracingConfig } from "./tracing";

/** False in builds without relay tracing configured, where there is nothing to turn off. */
export const connectionTracesAvailable = resolveTracingConfig() !== null;

// Shared by every switch, so a save that finishes after a newer change cannot turn sending back on.
let latestChange = 0;

/** Sending stops before the save and starts only after it, unless a newer change came since. */
async function applyConnectionTracesChange(
  value: boolean,
  save: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
) {
  const sequence = ++latestChange;
  if (!value) setConnectionTracesEnabled(false);
  const result = await save();
  if (sequence !== latestChange) return;
  if (result._tag === "Failure") {
    console.warn("[diagnostics] could not save the connection traces setting", result.cause);
    if (!value) setConnectionTracesEnabled(true);
    return;
  }
  if (value) setConnectionTracesEnabled(true);
}

/** The phone's T3 Connect connection traces, separate from crash reports. */
export function ConnectionTracesSwitch() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences, { reportFailure: false });
  // One change at a time, so a slow save never turns sending back on after a later opt-out.
  const [saving, setSaving] = useState(false);
  const gt = useGT();
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const enabled = AsyncResult.isSuccess(preferences)
    ? preferences.value.connectionTracesEnabled !== false
    : true;

  const change = (value: boolean) => {
    setSaving(true);
    void applyConnectionTracesChange(value, () =>
      savePreferences({ connectionTracesEnabled: value }),
    ).finally(() => setSaving(false));
  };

  return (
    <SettingsSwitchRow
      icon="point.3.connected.trianglepath.dotted"
      label={gt("Send connection traces")}
      disabled={!ready || saving}
      value={enabled}
      onValueChange={change}
    />
  );
}
