import { useRef, useState } from "react";
import { Pressable, View, type TextInputInstance } from "react-native";

import { AppText, AppTextInput } from "../../components/AppText";

export interface BrowserLogin {
  readonly username: string;
  readonly password: string;
}

/**
 * Takes a saved login from this device's AutoFill (the Passwords key above the
 * iOS keyboard, or Android's autofill service) and hands it to the page.
 */
export function BrowserPasswordFill(props: {
  /** The page's origin when the card opened, the only site the login goes to. */
  readonly origin: string;
  readonly onFill: (login: BrowserLogin) => void;
  readonly onCancel: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const passwordInput = useRef<TextInputInstance>(null);
  // Empty the fields, then close on the next frame: iOS offers to save a password
  // field's value when the field leaves the screen, and this is not a login here.
  const close = (fill: boolean) => {
    const login = { username, password };
    setUsername("");
    setPassword("");
    requestAnimationFrame(() => (fill ? props.onFill(login) : props.onCancel()));
  };
  const canFill = username.length > 0 || password.length > 0;
  // An https site shows as its host; http keeps its scheme, so it reads as unencrypted.
  const site = props.origin.replace(/^https:\/\//, "");
  return (
    // Below the address bar and control row, where the page's dialog cards sit.
    <View className="absolute inset-x-3 top-28 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
      <View className="gap-1">
        <AppText className="font-t3-bold text-sm text-secondary-foreground">Fill password</AppText>
        <AppText className="text-sm text-secondary-foreground">{site}</AppText>
        <AppText className="text-xs text-foreground-muted">
          Choose a saved login above the keyboard. Only this site gets it: the username, then the
          password, which only goes into a password field.
        </AppText>
      </View>
      <AppTextInput
        accessibilityLabel="Username"
        placeholder="Username or email"
        value={username}
        onChangeText={setUsername}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="username"
        textContentType="username"
        importantForAutofill="yes"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordInput.current?.focus()}
      />
      <AppTextInput
        ref={passwordInput}
        accessibilityLabel="Password"
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="current-password"
        textContentType="password"
        importantForAutofill="yes"
        returnKeyType="done"
        onSubmitEditing={() => canFill && close(true)}
      />
      <View className="flex-row justify-end gap-3">
        <Pressable accessibilityRole="button" className="px-3 py-2" onPress={() => close(false)}>
          <AppText className="text-secondary-foreground">Cancel</AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canFill }}
          disabled={!canFill}
          className="px-3 py-2 disabled:opacity-50"
          onPress={() => close(true)}
        >
          <AppText className="font-t3-bold text-secondary-foreground">Fill</AppText>
        </Pressable>
      </View>
    </View>
  );
}
