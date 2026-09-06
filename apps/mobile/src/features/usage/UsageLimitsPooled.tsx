import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  formatDuration,
  formatResetsIn,
  remainingPercent,
  type LimitAccount,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { useId, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Defs, Path, Pattern, Rect, Svg } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { environmentPresentations } from "../../state/presentation";
import { ResetCredits } from "./UsageLimitsSection";
import { useProviderColors } from "./usageProviders";

const DRIVER_LABEL: Partial<Record<string, string>> = { codex: "Codex", claudeAgent: "Claude" };
const PACE_LABEL = { ahead: "Ahead of pace", on: "On pace", under: "Under pace" } as const;

function accountName(account: LimitAccount) {
  if (account.displayName) return account.displayName;
  if (!account.email) return DRIVER_LABEL[account.driver] ?? String(account.driver);
  const [local = "", domain = ""] = account.email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "Account";
}

/** The spent share comes back at reset. SVG keeps the hatching static on both platforms. */
function AccountSegment({
  remaining,
  color,
  pending,
}: {
  readonly remaining: number;
  readonly color: string;
  readonly pending: boolean;
}) {
  const patternId = useId().replace(/:/g, "");
  return (
    <Svg width="100%" height="100%" accessible={false}>
      <Defs>
        <Pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse">
          <Path d="M-1 1L1 -1M0 6L6 0M5 7L7 5" stroke={color} strokeWidth={1} opacity={0.22} />
        </Pattern>
      </Defs>
      {pending ? (
        <Rect
          x={`${remaining}%`}
          width={`${100 - remaining}%`}
          height="100%"
          fill={`url(#${patternId})`}
        />
      ) : null}
      <Rect width={`${remaining}%`} height="100%" fill={color} opacity={0.35} />
    </Svg>
  );
}

function PoolWindowCard({
  pool,
  color,
  now,
  environmentIds,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
}) {
  const navigation = useNavigation();
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  const openAccount = (account: LimitAccount) =>
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsUsageAccount",
        params: {
          accountKey: account.key,
          windowId: pool.id,
          windowKind: pool.kind,
          environmentIds,
          now,
        },
      },
    });
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="gap-1">
          <Text className="text-sm font-t3-medium text-foreground">{pool.label}</Text>
          <View className="flex-row items-baseline gap-1.5">
            <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
              {pool.remainingPercent}%
            </Text>
            <Text className="text-sm text-foreground-muted">left</Text>
          </View>
        </View>
        {pool.pace ? (
          <Text className="text-xs text-foreground-tertiary">{PACE_LABEL[pool.pace]}</Text>
        ) : null}
      </View>
      {nextRefill ? (
        <Text className="text-xs tabular-nums text-foreground-muted">
          ↻ +{nextRefill.restoresPercent}%{" "}
          {nextRefill.at <= now ? "now" : `in ${formatDuration(nextRefill.at - now)}`}
        </Text>
      ) : null}
      <View className="flex-row gap-1">
        {pool.members.map(({ account, window }, index) => (
          <Pressable
            key={account.key}
            accessibilityRole="button"
            accessibilityLabel={`Segment ${index + 1}, ${accountName(account)}, ${remainingPercent(window)}% left`}
            accessibilityHint="Show account details"
            onPress={() => openAccount(account)}
            className="h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-subtle"
          >
            <AccountSegment
              remaining={remainingPercent(window)}
              color={color}
              pending={Boolean(window.resetsAt)}
            />
            <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
              <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                {index + 1}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
      <View>
        {pool.members.map(({ account, window }, index) => {
          const credits = account.limits.resetCredits?.availableCount ?? 0;
          const resetsIn = formatResetsIn(window, now);
          return (
            <Pressable
              key={account.key}
              accessibilityRole="button"
              accessibilityLabel={`Segment ${index + 1}, ${accountName(account)}, ${remainingPercent(window)}% left${resetsIn ? `, ${resetsIn}` : ""}${credits ? `, ${credits} reset credits banked` : ""}`}
              accessibilityHint="Show account details"
              onPress={() => openAccount(account)}
              className="min-h-[44px] flex-row items-center gap-2 active:opacity-60"
            >
              <View className="size-5 items-center justify-center overflow-hidden rounded-md bg-subtle-strong">
                <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                  {index + 1}
                </Text>
              </View>
              <Text
                numberOfLines={1}
                className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
              >
                {accountName(account)}
              </Text>
              <Text className="text-sm font-t3-medium tabular-nums text-foreground">
                {remainingPercent(window)}%
              </Text>
              <View className="flex-row items-center gap-1">
                {resetsIn ? (
                  <Text className="text-xs tabular-nums text-foreground-muted">
                    {resetsIn.replace("resets in ", "↻ ")}
                  </Text>
                ) : null}
                {credits ? (
                  <>
                    {resetsIn ? <Text className="text-xs text-foreground-tertiary">·</Text> : null}
                    <SymbolView name="ticket" size={13} tintColorClassName="accent-icon" />
                    <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                      {credits}
                    </Text>
                  </>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function UsageLimitsSection({
  now,
  failedLabels,
  selectedEnvironmentIds,
}: {
  readonly now: number;
  readonly failedLabels: readonly string[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  const pools = collectLimitPools(collectLimitAccounts(selected), now);
  const notices = collectLimitNotices(selected);
  const colors = useProviderColors();
  return (
    <View className="gap-6">
      {failedLabels.length ? (
        <Text className="text-sm text-foreground-muted">
          {failedLabels.join(", ")} could not refresh limits. Showing the last known values.
        </Text>
      ) : null}
      {pools.length === 0 ? (
        <Text className="py-12 text-center text-base text-foreground-muted">
          {selected.size === 0
            ? "Select an environment to see limits."
            : "No provider on the selected environments reports subscription limits."}
        </Text>
      ) : null}
      {pools.map((pool) => (
        <View key={pool.driver} className="gap-3">
          <View className="flex-row items-center gap-2 px-1">
            <ProviderIcon provider={pool.driver} size={18} />
            <Text className="text-base font-t3-medium text-foreground">
              {DRIVER_LABEL[pool.driver] ?? pool.driver}
            </Text>
          </View>
          {pool.windows.map((window) => (
            <PoolWindowCard
              key={`${window.kind}:${window.id}`}
              pool={window}
              color={pool.driver === "claudeAgent" ? colors.claude : colors.codex}
              now={now}
              environmentIds={selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds]}
            />
          ))}
        </View>
      ))}
      {notices.map((notice) => (
        <Text key={notice} className="text-sm text-foreground-muted">
          {notice}
        </Text>
      ))}
    </View>
  );
}

type AccountScreenProps = StaticScreenProps<{
  accountKey: string;
  windowId: string;
  windowKind: LimitPoolWindow["kind"];
  environmentIds: readonly string[] | null;
  now: number;
}>;

/** Resolve the account again so live quota and credit updates reach the open detail screen. */
export function UsageLimitAccountScreen({ route }: AccountScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const { accountKey, windowId, windowKind, environmentIds, now } = route.params;
  const selectedIds =
    environmentIds === null ? null : new Set(environmentIds.map((id) => EnvironmentId.make(id)));
  const selected =
    selectedIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedIds.has(id)));
  const accounts = collectLimitAccounts(selected);
  const account = accounts.find((candidate) => candidate.key === accountKey);
  const pool = collectLimitPools(accounts, now)
    .find((candidate) => candidate.driver === account?.driver)
    ?.windows.find((candidate) => candidate.id === windowId && candidate.kind === windowKind);
  const window = pool?.members.find((member) => member.account.key === accountKey)?.window;
  const reset = pool?.resets.find((candidate) => candidate.member.account.key === accountKey);
  const [revealed, setRevealed] = useState(false);
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Account" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {!account || !window ? (
          <Text className="text-base text-foreground-muted">
            This account is no longer reporting limits on the selected environments.
          </Text>
        ) : (
          <>
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <ProviderIcon provider={account.driver} size={24} />
                <Text className="flex-1 text-xl font-t3-bold text-foreground">
                  {account.displayName ?? DRIVER_LABEL[account.driver] ?? account.driver}
                </Text>
              </View>
              {account.email ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? "Hide account email" : "Reveal account email"}
                  onPress={() => setRevealed((value) => !value)}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-sm text-foreground-muted">
                    {revealed ? account.email : "••••••@••••••"}
                  </Text>
                </Pressable>
              ) : null}
              {account.plan ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {account.plan}
                </Text>
              ) : null}
            </View>
            <View className="gap-3 rounded-[24px] border-continuous bg-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">{window.label}</Text>
              <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
                {remainingPercent(window)}% left
              </Text>
              {window.resetsAt ? (
                <Text selectable className="text-sm text-foreground-muted">
                  Resets{" "}
                  {new Date(window.resetsAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </Text>
              ) : null}
              {reset && reset.restoresPercent > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  Restores {reset.restoresPercent}% of the pool
                </Text>
              ) : null}
            </View>
            <View className="gap-2 rounded-[24px] border-continuous bg-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">
                {account.environments.length ? "Signed in" : "Source"}
              </Text>
              {account.environments.length ? (
                account.environments.map((environment) => (
                  <Text key={environment.environmentId} className="text-sm text-foreground-muted">
                    {environment.label}
                  </Text>
                ))
              ) : (
                <Text className="text-sm text-foreground-muted">{account.sourceLabel}</Text>
              )}
            </View>
            {account.redeem && account.limits.resetCredits ? (
              <View className="gap-3 rounded-[24px] border-continuous bg-card p-4">
                <Text className="text-sm font-t3-medium text-foreground">Reset credits</Text>
                <ResetCredits
                  key={account.key}
                  environmentId={account.redeem.environmentId}
                  input={account.redeem.input}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
