import { useRef } from "react";
import { T, useGT, useMessages } from "gt-react";
import { parseIgnoredCommandPrefixes } from "@t3tools/client-runtime/work-log/command-label";

import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function IgnoredCommandPrefixesSettings() {
  const gt = useGT();
  const m = useMessages();
  const setting = searchableSetting("ignored-command-prefixes");
  const prefixes = useScopedSettings().ignoredCommandPrefixes;
  const updateSettings = useUpdateScopedSettings();
  const edited = useRef(false);
  const value = prefixes.join("\n");

  return (
    <SettingsRow
      {...setting}
      title={m(setting.title)}
      description={
        <T>
          Hide command prefixes in activity labels and previews. Enter one per line. Full command
          details stay available.
        </T>
      }
      resetAction={
        prefixes.length > 0 ? (
          <SettingResetButton
            label="top-level commands to ignore"
            onClick={() => {
              edited.current = false;
              updateSettings({ ignoredCommandPrefixes: [] });
            }}
          />
        ) : null
      }
      control={
        <Textarea
          key={value}
          aria-label={gt("Top-level commands to ignore")}
          defaultValue={value}
          placeholder={gt("No commands ignored")}
          autoCapitalize="none"
          spellCheck={false}
          rows={3}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const next = parseIgnoredCommandPrefixes(event.target.value);
            if (edited.current && next.join("\n") !== value) {
              updateSettings({ ignoredCommandPrefixes: next });
            }
            edited.current = false;
          }}
        />
      }
    />
  );
}
