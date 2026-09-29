import { translate } from "@t3tools/i18n";
import { Pressable, View } from "react-native";
import { useTranslation } from "@t3tools/i18n/react";

import { AppText as Text } from "../../../components/AppText";
import { SettingsSection } from "./SettingsSection";

export function SettingsProjectOverridesSection(props: {
  readonly projectLabel: string;
  readonly hasOverrides: boolean;
  readonly supportsOverrides: boolean;
  readonly pending: boolean;
  readonly onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={translate("common:project", "Project")}>
      <View className="min-h-16 flex-row items-center gap-3 px-4 py-3">
        <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={2}>
          {props.projectLabel}
        </Text>
        {!props.pending && props.supportsOverrides && props.hasOverrides ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translate(
              "common:mobileUseEnvironmentDefaults",
              "Use environment defaults",
            )}
            onPress={props.onClear}
            className="px-2 py-2 active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-primary-text">{t("useDefaults")}</Text>
          </Pressable>
        ) : null}
      </View>
      {!props.supportsOverrides ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          {translate(
            "common:mobileUpdateEnvironmentsForOverrides",
            "Update the selected environments to edit project overrides.",
          )}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
