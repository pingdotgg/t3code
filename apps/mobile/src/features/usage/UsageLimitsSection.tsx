import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderConsumeResetCreditOutcome,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderResetCredits,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
  UsageProviderKind,
} from "@t3tools/contracts";
import {
  collectLimitSources,
  collectLimitsGroups,
  elapsedShare,
  formatDuration,
  formatResetsIn,
  limitsNotice,
  paceOf,
  providerLimitsLabel,
} from "@t3tools/shared/usageLimits";
import { type ReactNode, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useProviderColors } from "./usageProviders";

const PACE_LABEL = { ahead: "ahead of pace", on: "on pace", under: "under pace" } as const;
const DRIVER_LABEL: Partial<Record<string, string>> = { codex: "Codex", claudeAgent: "Claude" };

type Driver = ServerProvider["driver"];

/** The series colour the usage chart uses for this driver, so the two views read as one. */
function useBarColor(driver: Driver): string | null {
  const colors = useProviderColors();
  const kind: UsageProviderKind | null =
    driver === "codex" ? "codex" : driver === "claudeAgent" ? "claude" : null;
  return kind ? colors[kind] : null;
}

/**
 * One window as a bar spanning its whole duration: the fill is quota spent,
 * the hairline is how far into the window the clock is. Pace sits under the
 * left edge, the countdown under the right, so a row reads in one glance.
 */
function WindowRow(props: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string | null;
  readonly now: number;
}) {
  const { window, now } = props;
  const used = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
  const elapsed = elapsedShare(window, now);
  const pace = paceOf(window, now);
  const resetsIn = formatResetsIn(window, now);
  return (
    <View className="gap-1">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm text-foreground">{window.label}</Text>
        <Text className="text-sm font-t3-medium tabular-nums text-foreground">{used}%</Text>
      </View>
      <View className="h-3 justify-center">
        <View className="h-1.5 flex-row overflow-hidden rounded-full bg-subtle">
          <View
            className={
              used >= 90
                ? "h-full rounded-full bg-destructive"
                : used >= 70
                  ? "h-full rounded-full bg-warning"
                  : "h-full rounded-full bg-foreground"
            }
            style={[
              { flex: used },
              used < 70 && props.color ? { backgroundColor: props.color } : null,
            ]}
          />
          <View style={{ flex: 100 - used }} />
        </View>
        {elapsed !== null ? (
          <View
            className="absolute top-0 bottom-0 w-px bg-foreground"
            style={{ left: `${elapsed * 100}%`, opacity: 0.6 }}
          />
        ) : null}
      </View>
      {pace || resetsIn ? (
        <View className="flex-row justify-between gap-3">
          <Text className="text-xs text-foreground-tertiary">{pace ? PACE_LABEL[pace] : ""}</Text>
          <Text className="text-xs tabular-nums text-foreground-tertiary">{resetsIn ?? ""}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** One account: icon, name and plan on a single line, then its windows. */
function AccountLimits(props: {
  readonly driver: Driver;
  readonly label: string;
  readonly instanceLabel: string;
  readonly detail: string | undefined;
  readonly limits: ServerProvider["usageLimits"];
  readonly now: number;
  readonly first: boolean;
  readonly footer?: ReactNode;
}) {
  const { limits, now } = props;
  const color = useBarColor(props.driver);
  if (!limits) return null;
  const notice = limitsNotice(limits);
  return (
    <View className={props.first ? "gap-3 p-4" : "gap-3 border-t border-border-subtle p-4"}>
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider={props.driver} size={16} />
        <View className="min-w-0 flex-1 flex-row items-baseline gap-2">
          <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
          {props.instanceLabel !== props.label ? (
            <Text className="shrink text-xs text-foreground-tertiary" numberOfLines={1}>
              · {props.instanceLabel}
            </Text>
          ) : null}
          {props.detail ? (
            <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
              · {props.detail}
            </Text>
          ) : null}
        </View>
      </View>
      {notice ? (
        <Text className="text-sm text-foreground-muted">{notice}</Text>
      ) : (
        <View className="gap-3">
          {limits.windows.map((window) => (
            <WindowRow key={window.id} window={window} color={color} now={now} />
          ))}
        </View>
      )}
      {props.footer}
    </View>
  );
}

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/**
 * Banked reset credits with a confirmed redeem action. Redeeming spends a
 * credit the provider granted the user, so it goes through the native
 * confirm alert rather than firing on a bare tap.
 */
function ResetCredits(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly credits: ServerProviderResetCredits;
  readonly now: number;
}) {
  const { environmentId, instanceId, credits, now } = props;
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  if (credits.availableCount === 0 && status === null) return null;

  const expiresIn = credits.nextExpiresAt
    ? formatDuration(Date.parse(credits.nextExpiresAt) - now)
    : null;
  const summary =
    credits.availableCount === 0
      ? "No reset credits banked"
      : `${credits.availableCount} ${credits.availableCount === 1 ? "reset credit" : "reset credits"} banked${
          expiresIn ? ` · next expires in ${expiresIn}` : ""
        }`;

  const redeem = async () => {
    setBusy(true);
    setStatus(null);
    const result = await consume({ environmentId, input: { instanceId } });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(OUTCOME_TEXT[result.value.outcome]);
      return;
    }
    setStatus(
      "error" in result.cause && result.cause.error instanceof Error
        ? result.cause.error.message
        : "Could not use the reset credit.",
    );
  };

  const confirm = () => {
    Alert.alert(
      "Use a reset credit?",
      "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Use credit", onPress: () => void redeem() },
      ],
    );
  };

  return (
    <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
      <Text className="text-xs tabular-nums text-foreground-tertiary">{summary}</Text>
      {credits.availableCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={confirm}
          className="rounded-full bg-subtle-strong px-3 py-1.5"
        >
          <Text className="text-sm font-t3-medium text-foreground">
            {busy ? "Using credit…" : "Use a reset credit"}
          </Text>
        </Pressable>
      ) : null}
      {status ? <Text className="text-sm text-foreground">{status}</Text> : null}
    </View>
  );
}

function ProviderLimits(props: {
  readonly provider: ServerProvider;
  readonly environmentId: EnvironmentId;
  readonly now: number;
  readonly first: boolean;
}) {
  const { provider, environmentId, now } = props;
  const credits = provider.usageLimits?.resetCredits;
  return (
    <AccountLimits
      driver={provider.driver}
      label={DRIVER_LABEL[provider.driver] ?? String(provider.driver)}
      instanceLabel={providerLimitsLabel(provider, (driver) => DRIVER_LABEL[driver])}
      detail={provider.auth.label}
      limits={provider.usageLimits}
      now={now}
      first={props.first}
      footer={
        credits ? (
          <ResetCredits
            environmentId={environmentId}
            instanceId={provider.instanceId}
            credits={credits}
            now={now}
          />
        ) : undefined
      }
    />
  );
}

/** Emails stay off the phone screen; the plan and driver identify the row. */
function SourceAccountLimits(props: {
  readonly account: UsageLimitSourceAccount;
  readonly now: number;
  readonly first: boolean;
}) {
  const { account } = props;
  return (
    <AccountLimits
      driver={account.driver}
      label={DRIVER_LABEL[account.driver] ?? String(account.driver)}
      instanceLabel="CLI Proxy"
      detail={account.plan}
      limits={account.usageLimits}
      now={props.now}
      first={props.first}
    />
  );
}

/**
 * Re-probes every provider (and usage-limit source) on each connected
 * environment; the fresh snapshots then arrive over the config stream.
 * Countdowns and pace anchor to `now` rather than ticking, so a refresh also
 * re-anchors the clock: quota and elapsed time move together, or not at all.
 * Environments whose probe failed are named, since their rows keep showing
 * the previous quota with nothing else to say so.
 */
export function useRefreshLimits() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [failedLabels, setFailedLabels] = useState<readonly string[]>([]);
  // Always toggles `refreshing`, even with nothing to probe: Android's
  // RefreshControl keeps its spinner up until it sees true then false.
  const refresh = async () => {
    const connected = [...presentations].filter(
      ([, presentation]) => presentation.connection.phase === "connected",
    );
    setRefreshing(true);
    try {
      const results = await Promise.all(
        connected.map(([environmentId]) => refreshProviders({ environmentId, input: {} })),
      );
      setFailedLabels(
        connected
          .filter((_, index) => results[index]?._tag === "Failure")
          .map(([, presentation]) => presentation.entry.target.label),
      );
    } finally {
      setNow(Date.now());
      setRefreshing(false);
    }
  };
  return { now, refreshing, failedLabels, refresh };
}

/**
 * Subscription quota windows from every connected environment's providers,
 * read from the config each environment already streams.
 */
export function UsageLimitsSection(props: {
  readonly now: number;
  readonly failedLabels: readonly string[];
}) {
  const { now } = props;
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const groups = collectLimitsGroups(presentations);
  const sources = collectLimitSources(presentations);

  if (groups.length === 0 && sources.length === 0) {
    return (
      <Text className="py-16 text-center text-base text-foreground-muted">
        No provider on a connected environment reports subscription limits.
      </Text>
    );
  }

  return (
    <>
      {props.failedLabels.length > 0 ? (
        <View className="rounded-[16px] border-continuous bg-card px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            {props.failedLabels.join(", ")} could not refresh limits. Showing the last known values.
          </Text>
        </View>
      ) : null}
      {groups.map((group) => (
        <SettingsSection
          key={group.environmentId}
          title={group.environmentLabel ?? "Providers"}
          card
        >
          {group.providers.map((provider, index) => (
            <ProviderLimits
              key={provider.instanceId}
              provider={provider}
              environmentId={group.environmentId}
              now={now}
              first={index === 0}
            />
          ))}
        </SettingsSection>
      ))}
      {sources.map((source) => (
        <SettingsSection key={source.key} card>
          {source.error ? (
            <Text className="p-4 text-sm text-foreground-muted">{source.error}</Text>
          ) : source.accounts.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              {source.hiddenAccountCount > 0
                ? "All accounts are shown by connected providers."
                : "No accounts reported."}
            </Text>
          ) : (
            source.accounts.map((account, index) => (
              <SourceAccountLimits
                key={account.id}
                account={account}
                now={now}
                first={index === 0}
              />
            ))
          )}
        </SettingsSection>
      ))}
    </>
  );
}
