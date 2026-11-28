import { useGT } from "gt-react-native";
import { useState } from "react";
import { Keyboard, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SecretTextInput } from "../../components/ui/SecretTextInput";

export function FilePasswordPrompt(props: {
  readonly incorrect: boolean;
  readonly onSubmit: (password: string) => void;
}) {
  const gt = useGT();
  const [password, setPassword] = useState("");
  const submit = (value: string) => {
    if (value.length === 0) return;
    setPassword("");
    Keyboard.dismiss();
    props.onSubmit(value);
  };
  return (
    <View className="flex-1 items-center justify-center px-6">
      <View className="w-full max-w-sm gap-3">
        <Text accessibilityLiveRegion="polite" className="text-center text-foreground">
          {props.incorrect
            ? gt("Incorrect password. Try again.")
            : gt("This file requires a password.")}
        </Text>
        <SecretTextInput
          accessibilityLabel={gt("File password")}
          placeholder={gt("File password")}
          value={password}
          editable
          onChangeText={setPassword}
          onSubmitEditing={submit}
        />
        <Button
          label={gt("Unlock")}
          disabled={password.length === 0}
          onPress={() => submit(password)}
        />
      </View>
    </View>
  );
}
