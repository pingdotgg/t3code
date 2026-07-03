import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useSyncExternalStore, type PropsWithChildren } from "react";

import { T3KeyboardCommands } from "../../native/T3KeyboardCommands";
import {
  dispatchHardwareKeyboardCommand,
  getHardwareKeyboardCommandRegistrationVersion,
  getRegisteredHardwareKeyboardCommands,
  parseActiveThreadPath,
  subscribeToHardwareKeyboardCommandRegistrations,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

export function HardwareKeyboardCommandProvider({
  children,
  pathname,
}: PropsWithChildren<{ readonly pathname: string }>) {
  const navigation = useNavigation();
  const registrationVersion = useSyncExternalStore(
    subscribeToHardwareKeyboardCommandRegistrations,
    getHardwareKeyboardCommandRegistrationVersion,
    getHardwareKeyboardCommandRegistrationVersion,
  );
  const enabledCommands = useMemo(() => {
    const commands = new Set<HardwareKeyboardCommand>(getRegisteredHardwareKeyboardCommands());
    commands.add("newTask");
    if (pathname !== "/" || navigation.canGoBack()) commands.add("back");
    if (parseActiveThreadPath(pathname)) {
      commands.add("files");
      commands.add("terminal");
      commands.add("review");
    }
    return [...commands];
  }, [pathname, registrationVersion, navigation]);

  const onCommand = useCallback(
    (command: HardwareKeyboardCommand) => {
      if (dispatchHardwareKeyboardCommand(command)) return;

      if (command === "newTask") {
        navigation.navigate("NewTaskSheet", { screen: "NewTask" });
        return;
      }
      if (command === "back") {
        if (navigation.canGoBack()) {
          navigation.goBack();
        } else {
          navigation.dispatch(StackActions.replace("Home"));
        }
        return;
      }

      const thread = parseActiveThreadPath(pathname);
      if (!thread) return;
      if (command === "files" && !/\/files(?:\/|$)/.test(pathname)) {
        navigation.navigate("ThreadFiles", thread);
      }
      if (command === "terminal" && !/\/terminal(?:\/|$)/.test(pathname)) {
        navigation.navigate("ThreadTerminal", thread);
      }
      if (command === "review" && !/\/review(?:\/|$)/.test(pathname)) {
        navigation.navigate("ThreadReview", thread);
      }
    },
    [pathname, navigation],
  );

  return (
    <T3KeyboardCommands enabledCommands={enabledCommands} onCommand={onCommand}>
      {children}
    </T3KeyboardCommands>
  );
}
