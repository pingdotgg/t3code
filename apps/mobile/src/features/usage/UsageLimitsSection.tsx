import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderConsumeResetCreditOutcome,
  ProviderConsumeResetCreditInput,
  ServerProvider,
  ServerProviderResetCredits,
  ServerProviderUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import {
  elapsedShare,
  formatDuration,
  formatResetsIn,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { type ReactNode, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProviderColors } from "./usageProviders";

const PACE_LABEL = { ahead: "ahead of pace", on: "on pace", under: "under pace" } as const;

type Driver = ServerProvider["driver"];

/** The series colour the usage chart uses for this driver, so the two views read as one. */
function useBarColor(driver: Driver): string | null {
  const colors = useProviderColors();
  const kind: UsageProviderKind | null =
    driver === "codex" ? "codex" : driver === "claudeAgent" ? "claude" : null;
  return kind ? colors[kind] : null;
}

/**
 * One window as a bar spanning its whole duration: the fill is quota left,
 * the hairline is how much of the window is left, so even spending keeps the
 * fill on the line. Pace sits under the left edge, the countdown under the
 * right, so a row reads in one glance.
 */
function WindowRow(props: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string | null;
  readonly now: number;
}) {
  const { window, now } = props;
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  const timeLeft = elapsed === null ? null : Math.round((1 - elapsed) * 100);
  const pace = paceOf(window, now);
  const resetsIn = formatResetsIn(window, now);
  return (
    <View className="gap-1">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm text-foreground">{window.label}</Text>
        <Text className="text-sm font-t3-medium tabular-nums text-foreground">
          {remaining}% left
        </Text>
      </View>
      <View className="h-3 justify-center">
        <View className="h-1.5 flex-row overflow-hidden rounded-full bg-subtle">
          <View
            className={
              remaining <= 10
                ? "h-full rounded-full bg-red-500"
                : remaining <= 30
                  ? "h-full rounded-full bg-amber-500"
                  : "h-full rounded-full bg-foreground"
            }
            style={[
              { flex: remaining },
              remaining > 30 && props.color ? { backgroundColor: props.color } : null,
            ]}
          />
          <View style={{ flex: 100 - remaining }} />
        </View>
        {timeLeft !== null ? (
          <View
            className="absolute top-0 bottom-0 w-px bg-foreground"
            style={{ left: `${timeLeft}%`, opacity: 0.6 }}
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
export function AccountLimits(props: {
  readonly driver: Driver;
  readonly label: string;
  readonly instanceLabel: string;
  readonly detail: string | undefined;
  readonly limits: ServerProvider["usageLimits"];
  readonly now: number;
  readonly first: boolean;
  /** Tighter padding for the composer card. */
  readonly dense?: boolean;
  /** Sits at the end of the heading row, such as a close control. */
  readonly trailing?: ReactNode;
  readonly footer?: ReactNode;
}) {
  const { limits, now, dense = false } = props;
  const color = useBarColor(props.driver);
  if (!limits) return null;
  const notice = limitsNotice(limits);
  const padding = dense ? "px-4 py-3" : "p-4";
  return (
    <View
      className={
        props.first ? `gap-3 ${padding}` : `gap-3 border-t border-border-subtle ${padding}`
      }
    >
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
        {props.trailing}
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
export function ResetCredits(props: {
  readonly environmentId: EnvironmentId;
  readonly input: ProviderConsumeResetCreditInput;
  readonly credits: ServerProviderResetCredits;
  readonly now: number;
  /** A smaller pill for the composer card. */
  readonly dense?: boolean;
}) {
  const { environmentId, input, credits, now, dense = false } = props;
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  if (dense && credits.availableCount === 0 && status === null) return null;

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
    const result = await consume({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(result.value.warning ?? OUTCOME_TEXT[result.value.outcome]);
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
          className={
            dense
              ? "rounded-full bg-subtle-strong px-2.5 py-1"
              : "min-h-[44px] justify-center rounded-full bg-subtle-strong px-3 py-1.5"
          }
        >
          <Text
            className={
              dense
                ? "text-xs font-t3-medium text-foreground"
                : "text-sm font-t3-medium text-foreground"
            }
          >
            {busy ? "Using…" : "Use reset"}
          </Text>
        </Pressable>
      ) : null}
      {status ? <Text className="text-sm text-foreground">{status}</Text> : null}
    </View>
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
export function useRefreshLimits(selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [failedEnvironments, setFailedEnvironments] = useState<
    readonly { environmentId: EnvironmentId; label: string }[]
  >([]);
  // Always toggles `refreshing`, even with nothing to probe: Android's
  // RefreshControl keeps its spinner up until it sees true then false.
  const refresh = async () => {
    const connected = [...presentations].filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    );
    setRefreshing(true);
    try {
      const results = await Promise.all(
        connected.map(([environmentId]) => refreshProviders({ environmentId, input: {} })),
      );
      setFailedEnvironments(
        connected
          .filter((_, index) => results[index]?._tag === "Failure")
          .map(([environmentId, presentation]) => ({
            environmentId,
            label: presentation.entry.target.label,
          })),
      );
    } finally {
      setNow(Date.now());
      setRefreshing(false);
    }
  };
  const failedLabels = failedEnvironments
    .filter(
      ({ environmentId }) =>
        selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId),
    )
    .map(({ label }) => label);
  return { now, refreshing, failedLabels, refresh };
}
