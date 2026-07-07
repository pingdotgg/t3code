import { useWaitlist } from "@clerk/expo";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useState } from "react";

import { useThemeColor } from "../../lib/useThemeColor";
import { CloudWaitlistJoinRejectedError, joinCloudWaitlist } from "./cloudWaitlistJoin";

export function CloudWaitlistEnrollment(props: { readonly onSignIn: () => void }) {
  const { errors, fetchStatus, waitlist } = useWaitlist();
  const colors = useCloudWaitlistColors();
  const [emailAddress, setEmailAddress] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const isSubmitting = fetchStatus === "fetching";
  const fieldError = errors.fields.emailAddress?.longMessage;

  const joinWaitlist = async () => {
    const normalizedEmailAddress = emailAddress.trim();
    if (!normalizedEmailAddress || isSubmitting) {
      return;
    }

    setRequestError(null);
    try {
      await joinCloudWaitlist(waitlist, normalizedEmailAddress);
    } catch (error) {
      console.error(error);
      setRequestError(
        error instanceof CloudWaitlistJoinRejectedError
          ? "Could not join the waitlist. Check your email address and try again."
          : "Could not join the waitlist. Check your connection and try again.",
      );
    }
  };

  if (waitlist.id) {
    return (
      <View style={styles.content}>
        <Text className="text-center font-t3-bold text-xl text-foreground">
          You are on the waitlist
        </Text>
        <Text className="text-center font-sans text-base text-foreground-secondary">
          We will email you when your T3 Cloud access is ready.
        </Text>
        <SignInAction onPress={props.onSignIn} />
      </View>
    );
  }

  return (
    <View style={styles.content}>
      <Text className="font-sans text-base text-foreground-secondary">
        Enter your email and we will let you know when access is ready.
      </Text>

      <View style={styles.field}>
        <Text className="font-t3-bold text-sm text-foreground-secondary">Email address</Text>
        <TextInput
          accessibilityLabel="Email address"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          className="font-sans text-lg text-foreground"
          keyboardType="email-address"
          onChangeText={(value) => {
            setEmailAddress(value);
            setRequestError(null);
          }}
          onSubmitEditing={() => void joinWaitlist()}
          placeholder="Enter your email address"
          placeholderTextColor={colors.placeholder}
          returnKeyType="join"
          style={[
            styles.input,
            {
              backgroundColor: colors.input,
              borderColor:
                fieldError || requestError ? colors.dangerForeground : colors.inputBorder,
            },
          ]}
          textContentType="emailAddress"
          value={emailAddress}
        />
        {fieldError || requestError ? (
          <Text
            accessibilityLiveRegion="polite"
            className="font-sans text-sm text-danger-foreground"
            selectable
          >
            {fieldError ?? requestError}
          </Text>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{
          busy: isSubmitting,
          disabled: isSubmitting || emailAddress.trim().length === 0,
        }}
        disabled={isSubmitting || emailAddress.trim().length === 0}
        onPress={() => void joinWaitlist()}
        style={[
          styles.primaryButton,
          {
            backgroundColor: colors.primary,
            opacity: isSubmitting || emailAddress.trim().length === 0 ? 0.45 : 1,
          },
        ]}
      >
        {isSubmitting ? <ActivityIndicator color={colors.primaryForeground} size="small" /> : null}
        <Text className="font-t3-bold text-base text-primary-foreground">
          {isSubmitting ? "Joining" : "Join the waitlist"}
        </Text>
      </Pressable>

      <SignInAction onPress={props.onSignIn} />
    </View>
  );
}

function SignInAction(props: { readonly onPress: () => void }) {
  return (
    <View style={styles.signInRow}>
      <Text className="font-sans text-base text-foreground-secondary">Already have access?</Text>
      <Pressable accessibilityRole="button" hitSlop={8} onPress={props.onPress}>
        <Text className="font-t3-bold text-base text-foreground">Sign in</Text>
      </Pressable>
    </View>
  );
}

function useCloudWaitlistColors() {
  return {
    dangerForeground: String(useThemeColor("--color-danger-foreground")),
    input: String(useThemeColor("--color-input")),
    inputBorder: String(useThemeColor("--color-input-border")),
    placeholder: String(useThemeColor("--color-placeholder")),
    primary: String(useThemeColor("--color-primary")),
    primaryForeground: String(useThemeColor("--color-primary-foreground")),
  };
}

const styles = StyleSheet.create({
  content: {
    gap: 18,
  },
  field: {
    gap: 8,
  },
  input: {
    borderCurve: "continuous",
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 54,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  primaryButton: {
    alignItems: "center",
    borderRadius: 999,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 54,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  signInRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    justifyContent: "center",
    paddingTop: 4,
  },
});
