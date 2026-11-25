import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react-native";
import { useEffect } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { WindowCover } from "../../components/ui/WindowCover";
import { appLockEnabledAtom, appLockSessionAtom, unlockApp } from "./appLockRuntime";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };

/** Covers the app until the owner unlocks it, and while it is in the background. */
export function AppLockGate() {
  const gt = useGT();
  // The native splash screen stays up until preferences load, so nothing shows before this knows.
  const enabled = useAtomValue(appLockEnabledAtom);
  const session = useAtomValue(appLockSessionAtom);
  const locked = enabled && !session.unlocked;
  const promptMessage = gt("Unlock T3 Code");
  const autoPrompt = locked && session.active && session.autoPrompt && !session.prompting;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the system biometric prompt when the app comes to the front locked
  useEffect(() => {
    if (autoPrompt) void unlockApp(promptMessage);
  }, [autoPrompt, promptMessage]);

  return (
    <WindowCover visible={locked} obscured={enabled && !session.active}>
      <View
        accessibilityViewIsModal
        className="absolute inset-0 items-center justify-center gap-5 bg-screen px-8"
      >
        <SymbolView name={LOCK_SYMBOL} size={36} tintColorClassName="accent-foreground-muted" />
        {locked ? (
          <>
            <Text className="text-center text-lg font-t3-medium text-foreground">
              <T>T3 Code is locked</T>
            </Text>
            <Button
              tone="primary"
              label={gt("Unlock", { $context: "verb, unlocks the app" })}
              loading={session.prompting}
              onPress={() => void unlockApp(promptMessage)}
            />
          </>
        ) : null}
      </View>
    </WindowCover>
  );
}
