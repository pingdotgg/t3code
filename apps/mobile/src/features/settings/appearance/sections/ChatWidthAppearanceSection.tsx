import type { ChatWidth } from "@t3tools/contracts/settings";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

export function ChatWidthAppearanceSection() {
  const gt = useGT();
  const { isReady, chatWidth, setChatWidth } = useAppearancePreferences();
  const choices: ReadonlyArray<{
    readonly value: ChatWidth;
    readonly label: string;
    readonly description: string;
  }> = [
    {
      value: "comfortable",
      label: gt("Comfortable"),
      description: gt("Messages keep a readable width on large screens."),
    },
    {
      value: "wide",
      label: gt("Wide"),
      description: gt("Messages grow wider on tablets and in landscape."),
    },
    {
      value: "full",
      label: gt("Full", { $context: "chat width" }),
      description: gt("Messages use the whole width of the screen."),
    },
  ];
  return (
    <SettingsSection title={gt("Chat width")} footer={gt("The composer keeps its width.")}>
      <View accessibilityRole="radiogroup">
        {choices.map((choice, index) => (
          <SettingsChoiceRow
            key={choice.value}
            label={choice.label}
            description={choice.description}
            disabled={!isReady}
            selected={chatWidth === choice.value}
            onPress={() => setChatWidth(choice.value)}
            separated={index > 0}
          />
        ))}
      </View>
    </SettingsSection>
  );
}
