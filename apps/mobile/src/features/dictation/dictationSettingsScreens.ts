import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import { createNativeStackScreen } from "@react-navigation/native-stack";

import type { AppScreenOptions } from "../../native/glass-header-options";
import { SettingsDictationCorrectionsRouteScreen } from "./SettingsDictationCorrectionsRouteScreen";
import { SettingsDictationModelsRouteScreen } from "./SettingsDictationModelsRouteScreen";
import { SettingsDictationVoiceRouteScreen } from "./SettingsDictationVoiceRouteScreen";

/** The fork's dictation pages, opened from Settings > Voice. */
export function dictationSettingsScreens(options: AppScreenOptions) {
  return {
    SettingsDictationModels: createNativeStackScreen({
      screen: SettingsDictationModelsRouteScreen,
      linking: "settings/voice/model",
      options: { ...options, title: m(msg("Dictation model")) },
    }),
    SettingsDictationVoice: createNativeStackScreen({
      screen: SettingsDictationVoiceRouteScreen,
      linking: "settings/voice/voice",
      options: { ...options, title: m(msg("Only my voice")) },
    }),
    SettingsDictationCorrections: createNativeStackScreen({
      screen: SettingsDictationCorrectionsRouteScreen,
      linking: "settings/voice/corrections",
      options: { ...options, title: m(msg("Corrections")) },
    }),
  };
}
