import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useTranslation } from "react-i18next";

import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { selectedUiLocaleChoice, type UiLocaleSetting } from "../../../../lib/uiLocale";
import { environmentServerConfigsAtom } from "../../../../state/server";
import { useWorkspaceEnvironments } from "../../../../state/workspace";
import { SettingsSection } from "../../components/SettingsSection";
import { useSettingsWriter } from "../../useSettingsWriter";

const LOCALE_CHOICES: ReadonlyArray<{
  readonly id: UiLocaleSetting;
  readonly labelKey: string;
}> = [
  { id: "system", labelKey: "settings.language.option.system" },
  { id: "en", labelKey: "settings.language.option.en" },
  { id: "zh-Hans", labelKey: "settings.language.option.zh-Hans" },
];

export function LanguageAppearanceSection() {
  const { t } = useTranslation();
  const environments = useWorkspaceEnvironments();
  const connected = environments.filter(
    (environment) => environment.isEnabled && environment.connectionState === "connected",
  );
  const configs = useAtomValue(environmentServerConfigsAtom);
  const settingsList = connected.map(
    (environment) => configs.get(environment.environmentId)?.settings ?? null,
  );
  // 06 号任务给 contracts 加上 uiLocale 后改读字段本身，去掉这个 cast。
  const withUiLocale = settingsList as ReadonlyArray<{
    readonly uiLocale?: UiLocaleSetting;
  } | null>;
  const writeSettings = useSettingsWriter();

  const pick = (value: UiLocaleSetting) => {
    void writeSettings(
      [],
      connected.map((environment) => ({
        environmentId: environment.environmentId,
        patch: { uiLocale: value } as ServerSettingsPatch,
      })),
    );
  };

  return (
    <SettingsSection title={t("settings.language.title")} footer={t("settings.language.footer")}>
      {LOCALE_CHOICES.map((choice) => (
        <ListChoiceRow
          key={choice.id}
          label={t(choice.labelKey)}
          selected={selectedUiLocaleChoice(withUiLocale) === choice.id}
          disabled={connected.length === 0}
          onPress={() => pick(choice.id)}
        />
      ))}
    </SettingsSection>
  );
}
