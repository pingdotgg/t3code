import { useAtomValue } from "@effect/atom-react";
import { useTranslation } from "react-i18next";

import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { selectedUiLocaleChoice, type UiLocaleSetting } from "../../../../lib/uiLocale";
import { environmentServerConfigsAtom } from "../../../../state/server";
import { useWorkspaceEnvironments } from "../../../../state/workspace";
import { SettingsSection } from "../../components/SettingsSection";
import { useSettingsWriter } from "../../useSettingsWriter";

const LOCALE_CHOICES: ReadonlyArray<{ readonly id: UiLocaleSetting }> = [
  { id: "system" },
  { id: "en" },
  { id: "zh-Hans" },
];

// Language names render in their own language, so only "system" is translated.
const NATIVE_LANGUAGE_LABELS: Record<Exclude<UiLocaleSetting, "system">, string> = {
  en: "English",
  "zh-Hans": "简体中文",
};

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
  const writeSettings = useSettingsWriter();

  const pick = (value: UiLocaleSetting) => {
    void writeSettings(
      [],
      connected.map((environment) => ({
        environmentId: environment.environmentId,
        patch: { uiLocale: value },
      })),
    );
  };

  return (
    <SettingsSection title={t("uiLocale.title")} footer={t("uiLocale.footer")}>
      {LOCALE_CHOICES.map((choice) => (
        <ListChoiceRow
          key={choice.id}
          label={choice.id === "system" ? t("uiLocale.system") : NATIVE_LANGUAGE_LABELS[choice.id]}
          selected={selectedUiLocaleChoice(settingsList) === choice.id}
          disabled={connected.length === 0}
          onPress={() => pick(choice.id)}
        />
      ))}
    </SettingsSection>
  );
}
