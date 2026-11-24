import { resolvePastedPath } from "@t3tools/shared/path";
import { useGT } from "gt-react";
import { useRef } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

// Roles are per machine, so the row edits server settings only.
export function ForkRolesSettingsSection() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const { scope, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["forkRolesDirectory"]);
  const edited = useRef(false);
  const draft = useRef("");
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  return (
    <SettingsSection title={gt("Roles", { $context: "settings section" })}>
      <SettingsRow
        {...setting("fork-roles-directory")}
        description={gt(
          "Folder of role files, one Markdown file per role. A thread given a role keeps that standing job. Leave empty to turn roles off.",
        )}
        serverScoped
        settingKeys={["forkRolesDirectory"]}
        resetAction={
          mixed || settings.forkRolesDirectory !== "" ? (
            <SettingResetButton
              ariaLabel={gt("Clear the roles directory")}
              onClick={() => updateSettings({ forkRolesDirectory: "" })}
            />
          ) : null
        }
        control={
          <Input
            key={`${scopeKey}:${mixed}:${settings.forkRolesDirectory}`}
            aria-label={gt("Roles directory")}
            autoCapitalize="none"
            spellCheck={false}
            placeholder={mixed ? gt("Mixed") : gt("Off", { $context: "roles directory is unset" })}
            defaultValue={mixed ? "" : settings.forkRolesDirectory}
            onFocus={(event) => {
              draft.current = event.target.value;
            }}
            onChange={(event) => {
              edited.current = true;
              draft.current = resolvePastedPath(draft.current, event.target.value);
              event.target.value = draft.current;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (edited.current && (mixed || value !== settings.forkRolesDirectory))
                updateSettings({ forkRolesDirectory: value });
              edited.current = false;
            }}
          />
        }
      />
    </SettingsSection>
  );
}
