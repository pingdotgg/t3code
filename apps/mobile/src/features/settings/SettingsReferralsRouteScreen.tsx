import { useAuth } from "@clerk/expo";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RelayReferralClaimResult } from "@t3tools/contracts/relay";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { buildReferralLink, normalizeReferralCode } from "@t3tools/shared/referral";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Share, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import { useThemeColor } from "../../lib/useThemeColor";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  claimManagedRelayReferralCommand,
  useManagedRelayReferralSummary,
} from "../cloud/managedRelayState";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";

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

export function SettingsReferralsRouteScreen() {
  const { isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const insets = useSafeAreaInsets();
  const summaryState = useManagedRelayReferralSummary();
  const claimReferral = useAtomCommand(claimManagedRelayReferralCommand, {
    reportFailure: false,
  });
  const [referralCode, setReferralCode] = useState("");
  const [isClaiming, setIsClaiming] = useState(false);
  const iconColor = useThemeColor("--color-icon");
  const iconSuccess = useThemeColor("--color-success");
  const inputPlaceholder = useThemeColor("--color-foreground-muted");
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

  if (!isSignedIn) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-8">
        <Text className="text-center text-base text-foreground-muted">
          Sign in to your T3 account to view referral points.
        </Text>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-1 text-sm leading-5 text-foreground-muted">
          Earn 67 points when someone you invite links their first T3 Code environment. Points stay
          with your T3 account on every device.
        </Text>

        {summaryState.error ? (
          <View className="gap-3 rounded-[24px] border border-danger-border bg-card p-5">
            <Text className="font-t3-bold text-danger-foreground">Could not load referrals</Text>
            <Text className="text-sm text-foreground-muted">{summaryState.error}</Text>
            <ConnectionSheetButton
              compact
              icon="arrow.clockwise"
              label="Try again"
              onPress={summaryState.refresh}
            />
          </View>
        ) : summary === null ? (
          <View className="items-center justify-center py-16">
            <ActivityIndicator />
          </View>
        ) : (
          <>
            <View className="flex-row gap-3">
              <View className="flex-1 rounded-[24px] bg-card p-4">
                <Text className="text-sm text-foreground-muted">Points</Text>
                <Text className="mt-1 text-3xl font-t3-bold text-foreground">{summary.points}</Text>
              </View>
              <View className="flex-1 rounded-[24px] bg-card p-4">
                <Text className="text-sm text-foreground-muted">Referrals</Text>
                <Text className="mt-1 text-3xl font-t3-bold text-foreground">
                  {summary.qualifiedReferrals}
                </Text>
                {summary.pendingReferrals > 0 ? (
                  <Text className="mt-1 text-xs text-foreground-muted">
                    {summary.pendingReferrals} pending
                  </Text>
                ) : null}
              </View>
            </View>

            <View className="gap-4 rounded-[24px] bg-card p-5">
              <View className="gap-1">
                <Text className="text-lg font-t3-bold text-foreground">Invite someone</Text>
                <Text className="text-sm leading-5 text-foreground-muted">
                  They must claim your code before linking their first environment.
                </Text>
              </View>
              <View className="flex-row items-center gap-3 rounded-[16px] border border-input-border bg-input px-4 py-3">
                <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                  {summary.referralCode}
                </Text>
                <CopyTextButton
                  accessibilityLabel="Copy referral code"
                  text={summary.referralCode}
                  tintColor={iconColor}
                  copiedTintColor={iconSuccess}
                />
              </View>
              <ConnectionSheetButton
                icon="arrow.up.right"
                label="Share referral link"
                tone="primary"
                onPress={() => {
                  void Share.share({
                    message: `Join me on T3 Code. Claim referral code ${summary.referralCode}: ${referralLink}`,
                    url: referralLink,
                  });
                }}
              />
            </View>

            {!summary.hasClaimedReferral ? (
              <View className="gap-4 rounded-[24px] bg-card p-5">
                <View className="gap-1">
                  <Text className="text-lg font-t3-bold text-foreground">
                    Have a referral code?
                  </Text>
                  <Text className="text-sm leading-5 text-foreground-muted">
                    Apply it before linking your first environment.
                  </Text>
                </View>
                <TextInput
                  autoCapitalize="characters"
                  autoCorrect={false}
                  editable={!isClaiming}
                  maxLength={19}
                  placeholder="ABCD1234EFAB5678"
                  placeholderTextColor={inputPlaceholder}
                  value={referralCode}
                  onChangeText={setReferralCode}
                  onSubmitEditing={() => void submitReferralCode()}
                  className="rounded-[16px] border border-input-border bg-input px-4 py-3.5 text-base text-foreground"
                />
                <ConnectionSheetButton
                  icon="checkmark"
                  label={isClaiming ? "Applying..." : "Apply code"}
                  disabled={isClaiming}
                  tone="primary"
                  onPress={() => void submitReferralCode()}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
