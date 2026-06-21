import { useWaitlist } from "@clerk/expo";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useState } from "react";

import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useThemeColor } from "../../lib/useThemeColor";

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
      const { error } = await waitlist.join({ emailAddress: normalizedEmailAddress });
      if (error) {
        setRequestError("Could not join the waitlist. Check your email address and try again.");
      }
    } catch {
      setRequestError("Could not join the waitlist. Check your connection and try again.");
    }
  };

  if (waitlist.id) {
    return (
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>You are on the waitlist</Text>
        <Text style={[styles.body, styles.confirmationBody, { color: colors.secondaryForeground }]}>
          We will email you when your T3 Cloud access is ready.
        </Text>
        <SignInAction onPress={props.onSignIn} />
      </View>
    );
  }

  return (
    <View style={styles.content}>
      <Text style={[styles.body, { color: colors.secondaryForeground }]}>
        Enter your email and we will let you know when access is ready.
      </Text>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.secondaryForeground }]}>Email address</Text>
        <TextInput
          accessibilityLabel="Email address"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
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
              color: colors.foreground,
            },
          ]}
          textContentType="emailAddress"
          value={emailAddress}
        />
        {fieldError || requestError ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.error, { color: colors.dangerForeground }]}
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
        <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
          {isSubmitting ? "Joining" : "Join the waitlist"}
        </Text>
      </Pressable>

      <SignInAction onPress={props.onSignIn} />
    </View>
  );
}

function SignInAction(props: { readonly onPress: () => void }) {
  const colors = useCloudWaitlistColors();
  return (
    <View style={styles.signInRow}>
      <Text style={[styles.body, { color: colors.secondaryForeground }]}>Already have access?</Text>
      <Pressable accessibilityRole="button" hitSlop={8} onPress={props.onPress}>
        <Text style={[styles.signInText, { color: colors.foreground }]}>Sign in</Text>
      </Pressable>
    </View>
  );
}

function useCloudWaitlistColors() {
  return {
    dangerForeground: String(useThemeColor("--color-danger-foreground")),
    foreground: String(useThemeColor("--color-foreground")),
    input: String(useThemeColor("--color-input")),
    inputBorder: String(useThemeColor("--color-input-border")),
    placeholder: String(useThemeColor("--color-placeholder")),
    primary: String(useThemeColor("--color-primary")),
    primaryForeground: String(useThemeColor("--color-primary-foreground")),
    secondaryForeground: String(useThemeColor("--color-foreground-secondary")),
  };
}

const styles = StyleSheet.create({
  body: {
    fontFamily: "DMSans_400Regular",
    ...MOBILE_TYPOGRAPHY.body,
  },
  buttonText: {
    fontFamily: "DMSans_700Bold",
    fontSize: MOBILE_TYPOGRAPHY.body.fontSize,
  },
  content: {
    gap: 18,
  },
  confirmationBody: {
    textAlign: "center",
  },
  error: {
    fontFamily: "DMSans_400Regular",
    ...MOBILE_TYPOGRAPHY.footnote,
  },
  field: {
    gap: 8,
  },
  input: {
    borderCurve: "continuous",
    borderRadius: 16,
    borderWidth: 1,
    fontFamily: "DMSans_400Regular",
    fontSize: MOBILE_TYPOGRAPHY.headline.fontSize,
    minHeight: 54,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  label: {
    fontFamily: "DMSans_700Bold",
    ...MOBILE_TYPOGRAPHY.footnote,
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
  signInText: {
    fontFamily: "DMSans_700Bold",
    ...MOBILE_TYPOGRAPHY.body,
  },
  title: {
    fontFamily: "DMSans_700Bold",
    ...MOBILE_TYPOGRAPHY.title,
    textAlign: "center",
  },
});
