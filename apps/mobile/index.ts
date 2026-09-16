// Installed via a side-effect import listed first so the fatal-error handler
// is in place before the rest of the app module graph evaluates.
import "./src/lib/installCrashLog";

import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";

// Required for react-native-screens' iOS FormSheet sizing fix when a nested
// native stack is rendered inside a non-fitToContents formSheet.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

registerRootComponent(App);
