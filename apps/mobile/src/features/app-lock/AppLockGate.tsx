import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react-native";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import { Modal, Platform, View } from "react-native";
import { FullWindowOverlay } from "react-native-screens";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { mobilePreferencesAtom } from "../../state/preferences";
import { appLockSessionAtom, unlockApp } from "./appLockRuntime";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };

/**
 * Covers the app until the owner unlocks it. On iOS it also covers the app while it is inactive,
 * so the app switcher snapshot shows no threads.
 */
export function AppLockGate() {
  const gt = useGT();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const session = useAtomValue(appLockSessionAtom);
  // The native splash screen stays up until preferences load, so nothing shows before this knows.
  const enabled =
    AsyncResult.isSuccess(preferencesResult) && preferencesResult.value.appLockEnabled === true;
  const locked = enabled && !session.unlocked;
  const promptMessage = gt("Unlock T3 Code");
  const autoPrompt = locked && session.active && session.autoPrompt && !session.prompting;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the system biometric prompt when the app comes to the front locked
  useEffect(() => {
    if (autoPrompt) void unlockApp(promptMessage);
  }, [autoPrompt, promptMessage]);

  const covered = locked || (Platform.OS === "ios" && enabled && !session.active);
  if (!covered) return null;

  const content = (
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
  );

  // A window above every native sheet, so nothing presented over the app shows through.
  return Platform.OS === "ios" ? (
    <FullWindowOverlay>{content}</FullWindowOverlay>
  ) : (
    <Modal visible animationType="none" statusBarTranslucent onRequestClose={() => {}}>
      {content}
    </Modal>
  );
}
