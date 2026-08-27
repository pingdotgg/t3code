import { useAuth } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RelayReferralClaimResult } from "@t3tools/contracts/relay";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import {
  buildReferralLink,
  buildReferralShareMessage,
  normalizeReferralCode,
  REFERRAL_SHARE_TITLE,
} from "@t3tools/shared/referral";
import type { ComponentProps } from "react";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Share,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { CopyTextButton } from "../../components/CopyTextButton";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  claimManagedRelayReferralCommand,
  useManagedRelayReferralSummary,
} from "../cloud/managedRelayState";
import { SettingsSection } from "./components/SettingsSection";

function showClaimResult(result: RelayReferralClaimResult): void {
  switch (result) {
    case "claimed":
      Alert.alert(
        "Referral applied",
        "Your referrer will receive 67 points after you link your first environment.",
      );
      return;
    case "already_claimed":
      Alert.alert("Referral already claimed", "This account already has a referral attached.");
      return;
    case "invalid_code":
      Alert.alert("Invalid referral code", "Check the code and try again.");
      return;
    case "self_referral":
      Alert.alert("Referral not applied", "You cannot use your own referral code.");
      return;
    case "ineligible":
      Alert.alert(
        "Referral not applied",
        "Referral codes must be claimed before linking an environment.",
      );
  }
}

function ReferralMetric(props: {
  readonly label: string;
  readonly value: number;
  readonly divided?: boolean;
}) {
  return (
    <View
      className={
        props.divided ? "flex-1 border-l border-border-subtle px-4 py-4" : "flex-1 px-4 py-4"
      }
    >
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text className="mt-0.5 text-2xl font-t3-bold tabular-nums text-foreground">
        {props.value}
      </Text>
    </View>
  );
}

function ReferralActionRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly detail: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const chevronColor = useThemeColor("--color-chevron");

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled ?? false }}
      className="flex-row items-center gap-4 border-t border-border-subtle p-4 disabled:opacity-50"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={22}
        tintColor={iconColor}
        type="monochrome"
        weight="regular"
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground">{props.label}</Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.detail}
        </Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={16}
        tintColor={chevronColor}
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}

export function SettingsReferralsRouteScreen() {
  const { isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const summaryState = useManagedRelayReferralSummary();
  const claimReferral = useAtomCommand(claimManagedRelayReferralCommand, {
    reportFailure: false,
  });
  const [referralCode, setReferralCode] = useState("");
  const [isClaiming, setIsClaiming] = useState(false);
  const iconColor = useThemeColor("--color-icon");
  const iconSuccess = useThemeColor("--color-success");
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const summary = summaryState.data;
  const referralLink = summary
    ? buildReferralLink(DEFAULT_HOSTED_APP_URL, summary.referralCode)
    : "";

  const submitReferralCode = async () => {
    const accountId = summaryState.accountId;
    const normalized = normalizeReferralCode(referralCode);
    if (!accountId || !normalized || isClaiming) {
      if (!normalized) Alert.alert("Invalid referral code", "Enter the 16-character code.");
      return;
    }

    setIsClaiming(true);
    const result = await claimReferral({ accountId, referralCode: normalized });
    setIsClaiming(false);
    if (result._tag === "Success") {
      setReferralCode("");
      showClaimResult(result.value.result);
      summaryState.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    Alert.alert(
      "Could not claim referral code",
      cause instanceof Error ? cause.message : "Try again.",
    );
  };

  const shareReferral = () => {
    if (!referralLink) return;
    void Share.share(
      {
        title: REFERRAL_SHARE_TITLE,
        message: buildReferralShareMessage(referralLink),
      },
      {
        dialogTitle: "Share referral link",
        subject: REFERRAL_SHARE_TITLE,
      },
    );
  };

  if (!isSignedIn) {
    return (
      <View className="flex-1 bg-sheet">
        {Platform.OS === "android" ? (
          <>
            <NativeStackScreenOptions options={{ headerShown: false }} />
            <AndroidScreenHeader title="Referrals" onBack={() => navigation.goBack()} />
          </>
        ) : null}
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-foreground-muted">
            Sign in to your T3 account to view referral points.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Referrals" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {summaryState.error ? (
          <SettingsSection card title="Referral points">
            <View className="gap-3 p-4">
              <Text className="text-base text-danger-foreground">
                Could not load referral points
              </Text>
              <Text className="text-sm text-foreground-muted">{summaryState.error}</Text>
              <Pressable
                accessibilityRole="button"
                className="self-start rounded-full bg-secondary px-4 py-2.5 active:opacity-60"
                onPress={summaryState.refresh}
              >
                <Text className="font-t3-medium text-secondary-foreground">Try again</Text>
              </Pressable>
            </View>
          </SettingsSection>
        ) : summary === null ? (
          <SettingsSection card title="Your referrals">
            <View className="items-center justify-center py-12">
              <ActivityIndicator />
            </View>
          </SettingsSection>
        ) : (
          <>
            <View className="gap-3">
              <SettingsSection card title="Your referrals">
                <View className="flex-row">
                  <ReferralMetric label="Points" value={summary.points} />
                  <ReferralMetric divided label="Successful" value={summary.qualifiedReferrals} />
                  <ReferralMetric divided label="Pending" value={summary.pendingReferrals} />
                </View>
              </SettingsSection>
              <Text className="px-2 text-sm leading-normal text-foreground-muted">
                Points belong to your T3 account, so this balance is the same on web, desktop, and
                mobile.
              </Text>
            </View>

            <View className="gap-3">
              <SettingsSection card title="Invite someone">
                <View className="flex-row items-center gap-4 p-4">
                  <SymbolView
                    name="link"
                    size={22}
                    tintColor={iconColor}
                    type="monochrome"
                    weight="regular"
                  />
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text className="text-lg text-foreground">Referral code</Text>
                    <Text
                      selectable
                      className="font-mono text-sm tracking-[0.5px] text-foreground-muted"
                      numberOfLines={1}
                    >
                      {summary.referralCode}
                    </Text>
                  </View>
                  <CopyTextButton
                    accessibilityLabel="Copy referral code"
                    text={summary.referralCode}
                    tintColor={iconColor}
                    copiedTintColor={iconSuccess}
                  />
                </View>
                <ReferralActionRow
                  icon="arrow.up.right"
                  label="Share referral link"
                  detail={referralLink}
                  disabled={!referralLink}
                  onPress={shareReferral}
                />
              </SettingsSection>
              <Text className="px-2 text-sm leading-normal text-foreground-muted">
                Your friend must claim the link before linking their first environment. You receive
                67 points after that environment connects.
              </Text>
            </View>

            {!summary.hasClaimedReferral ? (
              <View className="gap-3">
                <SettingsSection card title="Use a referral code">
                  <View className="gap-3 p-4">
                    <TextInput
                      accessibilityLabel="Referral code"
                      autoCapitalize="characters"
                      autoCorrect={false}
                      editable={!isClaiming}
                      maxLength={19}
                      placeholder="ABCD1234EFAB5678"
                      returnKeyType="done"
                      value={referralCode}
                      onChangeText={setReferralCode}
                      onSubmitEditing={() => void submitReferralCode()}
                    />
                    <Pressable
                      accessibilityLabel={
                        isClaiming ? "Applying referral code" : "Apply referral code"
                      }
                      accessibilityRole="button"
                      accessibilityState={{ disabled: isClaiming }}
                      className="min-h-[46px] items-center justify-center rounded-[14px] bg-primary px-4 active:opacity-70 disabled:opacity-50"
                      disabled={isClaiming}
                      onPress={() => void submitReferralCode()}
                    >
                      {isClaiming ? (
                        <ActivityIndicator color={primaryForeground} />
                      ) : (
                        <Text className="font-t3-medium text-primary-foreground">Apply code</Text>
                      )}
                    </Pressable>
                  </View>
                </SettingsSection>
                <Text className="px-2 text-sm leading-normal text-foreground-muted">
                  Apply a code before you link your first T3 Code environment.
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
