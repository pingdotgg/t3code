// Must stay first: the render counter wraps the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
// Next, so errors thrown while the rest of the app loads are recorded too.
import "./src/features/observability/observe";
import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";

// Enables iOS FormSheet sizing for nested native stacks in non-fitToContents sheets.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

registerRootComponent(App);
