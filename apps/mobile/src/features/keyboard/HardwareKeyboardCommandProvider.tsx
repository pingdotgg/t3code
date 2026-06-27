import { usePathname, useRouter } from "expo-router";
import { useCallback, useMemo, useSyncExternalStore, type PropsWithChildren } from "react";

import {
  buildThreadFilesRoutePath,
  buildThreadReviewRoutePath,
  buildThreadTerminalRoutePath,
  dismissRoute,
} from "../../lib/routes";
import { T3KeyboardCommands } from "../../native/T3KeyboardCommands";
import {
  dispatchHardwareKeyboardCommand,
  getHardwareKeyboardCommandRegistrationVersion,
  getRegisteredHardwareKeyboardCommands,
  parseActiveThreadPath,
  subscribeToHardwareKeyboardCommandRegistrations,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

export function HardwareKeyboardCommandProvider({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const router = useRouter();
  const registrationVersion = useSyncExternalStore(
    subscribeToHardwareKeyboardCommandRegistrations,
    getHardwareKeyboardCommandRegistrationVersion,
    getHardwareKeyboardCommandRegistrationVersion,
  );
  const enabledCommands = useMemo(() => {
    const commands = new Set<HardwareKeyboardCommand>(getRegisteredHardwareKeyboardCommands());
    commands.add("newTask");
    if (pathname !== "/" || router.canGoBack()) commands.add("back");
    if (parseActiveThreadPath(pathname)) {
      commands.add("files");
      commands.add("terminal");
      commands.add("review");
    }
    return [...commands];
  }, [pathname, registrationVersion, router]);

  const onCommand = useCallback(
    (command: HardwareKeyboardCommand) => {
      if (dispatchHardwareKeyboardCommand(command)) return;

      if (command === "newTask") {
        router.push("/new");
        return;
      }
      if (command === "back") {
        dismissRoute(router);
        return;
      }

      const thread = parseActiveThreadPath(pathname);
      if (!thread) return;
      if (command === "files" && !/\/files(?:\/|$)/.test(pathname)) {
        router.push(buildThreadFilesRoutePath(thread));
      }
      if (command === "terminal" && !/\/terminal(?:\/|$)/.test(pathname)) {
        router.push(buildThreadTerminalRoutePath(thread));
      }
      if (command === "review" && !/\/review(?:\/|$)/.test(pathname)) {
        router.push(buildThreadReviewRoutePath(thread));
      }
    },
    [pathname, router],
  );

  return (
    <T3KeyboardCommands enabledCommands={enabledCommands} onCommand={onCommand}>
      {children}
    </T3KeyboardCommands>
  );
}
