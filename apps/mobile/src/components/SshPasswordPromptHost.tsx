import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, View } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { AppText, AppTextInput } from "./AppText";
import {
  type PresentedSshPasswordPromptRequest,
  sshPasswordPromptBroker,
} from "./sshPasswordPromptBroker";
import { getSshPasswordPromptTiming } from "./sshPasswordPromptTiming";

export function SshPasswordPromptHost() {
  const [prompt, setPrompt] = useState<PresentedSshPasswordPromptRequest | null>(null);
  const [password, setPassword] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const pressedOverlay = useThemeColor("--color-subtle");

  useEffect(
    () =>
      sshPasswordPromptBroker.subscribe((nextPrompt) => {
        setPassword("");
        setNow(Date.now());
        setPrompt(nextPrompt);
      }),
    [],
  );

  useEffect(() => {
    if (prompt === null) {
      return;
    }
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(interval);
    };
  }, [prompt]);

  const timing =
    prompt === null
      ? null
      : getSshPasswordPromptTiming(prompt.expiresInMs, prompt.receivedAtMs, now);
  const isExpired = timing?.isExpired ?? false;
  const continueDisabled = password.length === 0 || isExpired;

  const finish = useCallback((requestId: string, value: string | null) => {
    sshPasswordPromptBroker.resolveCurrent(requestId, value);
  }, []);

  const submit = useCallback(() => {
    if (prompt !== null && password.length > 0 && !isExpired) {
      finish(prompt.requestId, password);
    }
  }, [finish, isExpired, password, prompt]);

  return (
    <Modal
      visible={prompt !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => {
        if (prompt !== null) {
          finish(prompt.requestId, null);
        }
      }}
    >
      {prompt === null ? null : (
        <View className="flex-1 items-center justify-center bg-backdrop px-8">
          <View className="w-full rounded-[24px] bg-card px-6 pb-4 pt-5">
            <View className="flex-row items-center justify-between gap-3">
              <AppText className="flex-1 text-lg font-t3-medium">SSH password required</AppText>
              {timing === null || timing.remainingLabel === null ? null : (
                <AppText
                  accessibilityLabel={
                    isExpired
                      ? "SSH password prompt expired"
                      : `${timing.remainingSeconds} seconds remaining`
                  }
                  className={
                    isExpired
                      ? "shrink-0 text-xs font-t3-medium text-danger-foreground"
                      : "shrink-0 text-xs text-foreground-secondary"
                  }
                >
                  {isExpired ? "Expired" : timing.remainingLabel}
                </AppText>
              )}
            </View>
            <AppText className="mt-2 text-sm text-foreground-secondary">
              Enter the password for {prompt.username ?? "SSH"} at {prompt.destination}.
            </AppText>
            <AppTextInput
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              className={`mt-4 rounded-xl bg-background px-4 py-3 text-base text-foreground ${isExpired ? "opacity-50" : ""}`}
              editable={!isExpired}
              onChangeText={setPassword}
              onSubmitEditing={submit}
              placeholder="Password"
              returnKeyType="done"
              secureTextEntry
              value={password}
            />
            {isExpired ? (
              <AppText className="mt-2 text-sm text-danger-foreground">
                This SSH password prompt expired. Try again.
              </AppText>
            ) : null}
            <View className="mt-4 flex-row justify-end gap-1">
              <View className="overflow-hidden rounded-full">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-10 items-center justify-center px-4"
                  android_ripple={{ color: pressedOverlay }}
                  onPress={() => finish(prompt.requestId, null)}
                >
                  <AppText className="text-base font-t3-medium">
                    {isExpired ? "Dismiss" : "Cancel"}
                  </AppText>
                </Pressable>
              </View>
              <View className="overflow-hidden rounded-full">
                <Pressable
                  accessibilityRole="button"
                  className="min-h-10 items-center justify-center px-4"
                  disabled={continueDisabled}
                  android_ripple={{ color: pressedOverlay }}
                  onPress={submit}
                >
                  <AppText
                    className={`text-base font-t3-medium ${continueDisabled ? "opacity-40" : ""}`}
                  >
                    Continue
                  </AppText>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      )}
    </Modal>
  );
}
