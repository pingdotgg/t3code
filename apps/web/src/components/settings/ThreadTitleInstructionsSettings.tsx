import { useRef } from "react";

import { useT } from "../../hooks/useI18n";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ThreadTitleInstructionsSettings() {
  const t = useT();
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadTitleInstructions"]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["threadTitleInstructions"]}
      {...searchableSetting("thread-title-instructions")}
      title={t("settings.threads.titleInstructions.title")}
      description={t("settings.threads.titleInstructions.description")}
      resetAction={
        mixed || settings.threadTitleInstructions !== "" ? (
          <SettingResetButton
            label={t("settings.threads.titleInstructions.resetLabel")}
            onClick={() => updateSettings({ threadTitleInstructions: "" })}
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={`${scopeKey}:${mixed}:${settings.threadTitleInstructions}`}
          aria-label={t("settings.threads.titleInstructions.a11y")}
          onChange={() => {
            edited.current = true;
          }}
          rows={4}
          defaultValue={mixed ? "" : settings.threadTitleInstructions}
          placeholder={
            mixed
              ? t("settings.threads.titleInstructions.placeholderMixed")
              : t("settings.threads.titleInstructions.placeholder")
          }
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.threadTitleInstructions))
              updateSettings({ threadTitleInstructions: value });
            edited.current = false;
          }}
        />
      </div>
    </SettingsRow>
  );
}
