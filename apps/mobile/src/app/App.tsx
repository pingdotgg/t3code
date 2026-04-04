import { useColorScheme } from "react-native";
import "./../../global.css";

import { SafeAreaProvider } from "react-native-safe-area-context";

import { LoadingScreen } from "../components/LoadingScreen";
import { MobileAppShell } from "./MobileAppShell";
import { useRemoteAppState } from "./useRemoteAppState";

export default function App() {
  const colorScheme = useColorScheme();
  const isDarkMode = colorScheme !== "light";
  const app = useRemoteAppState();
  let content;

  if (app.isLoadingSavedConnection) {
    content = <LoadingScreen isDarkMode={isDarkMode} message="Loading remote workspace…" />;
  } else if (app.reconnectingScreenVisible) {
    content = <LoadingScreen isDarkMode={isDarkMode} message="Reconnecting…" />;
  } else {
    content = <MobileAppShell app={app} isDarkMode={isDarkMode} />;
  }

  return <SafeAreaProvider>{content}</SafeAreaProvider>;
}
