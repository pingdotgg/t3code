import * as Dialog from "../../components/ui/Dialog";
import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderConsumeResetCreditOutcome,
  type ProviderConsumeResetCreditInput,
  type ServerProvider,
  type ServerProviderResetCredits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  formatDuration,
  formatResetsIn,
  limitsNotice,
  meterPercent,
  paceMarkPercent,
  paceOf,
} from "@t3tools/shared/usageLimits";
import { type ReactNode, useContext, useRef, useState } from "react";
import { Atom } from "effect/reactivity";
import { Linking, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNowMinuteMs } from "../../lib/clock";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  environmentIdsKey,
  limitsAutoRefreshSetAtom,
  limitsRefreshFailuresAtom,
  refreshEnvironmentLimits,
} from "./usageLimitsRefresh";
import { usageProviderKind, useProviderColors } from "./usageProviders";

const PACE_LABEL = { ahead: "ahead of pace", on: "on pace", under: "under pace" } as const;

type Driver = ServerProvider["driver"];

function useBarColor(driver: Driver): string | null {
  const colors = useProviderColors();
  const kind = usageProviderKind(driver);
  return kind ? colors[kind] : null;
}

function WindowRow(props: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string | null;
  readonly now: number;
}) {
  const { window, now } = props;
  const { usageDisplay } = useAppearancePreferences();
  const remaining = meterPercent(window.usedPercent, "left");
  const percent = meterPercent(window.usedPercent, usageDisplay);
  const mark = paceMarkPercent(window, now, usageDisplay);
  const pace = paceOf(window, now);
  const resetsIn = formatResetsIn(window, now);
  const [barWidth, setBarWidth] = useState(0);
  const tickX =
    mark === null || barWidth < 6
      ? null
      : Math.min(Math.max((barWidth * mark) / 100, 3), barWidth - 3);
  const bar = (
    <View
      className="h-1.5 flex-row overflow-hidden rounded-full bg-subtle"
      style={barWidth > 0 ? { width: barWidth } : undefined}
    >
      <View
        className={
          remaining <= 10
            ? "h-full rounded-full bg-red-500"
            : remaining <= 30
              ? "h-full rounded-full bg-amber-500"
              : "h-full rounded-full bg-foreground"
        }
        style={[
          { flex: percent },
          remaining > 30 && props.color ? { backgroundColor: props.color } : null,
        ]}
      />
      <View style={{ flex: 100 - percent }} />
    </View>
  );
  return (
    <View className="gap-1">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm text-foreground">{window.label}</Text>
        <Text className="text-sm font-t3-medium tabular-nums text-foreground">
          {percent}% {usageDisplay}
        </Text>
      </View>
      <View
        className="h-3 justify-center"
        onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
      >
        {tickX === null ? (
          bar
        ) : (
          <View className="h-1.5">
            {/* Clip the same full-width bar so neither fill proportions nor corner radii change. */}
            {(
              [
                [0, tickX - 3],
                [tickX + 3, barWidth],
              ] as const
            ).map(([start, end]) => (
              <View
                key={start}
                className="absolute top-0 bottom-0 overflow-hidden"
                style={{ left: start, width: end - start }}
              >
                <View style={{ marginLeft: -start }}>{bar}</View>
              </View>
            ))}
          </View>
        )}
        {tickX !== null ? (
          <View
            className="absolute top-px bottom-px w-0.5 rounded-full bg-foreground"
            style={{ left: tickX - 1 }}
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

function AccountInstanceLabel({ value }: { readonly value: string }) {
  const [revealed, setRevealed] = useState(false);
  if (!value.includes("@")) {
    return (
      <Text className="shrink text-xs text-foreground-tertiary" numberOfLines={1}>
        · {value}
      </Text>
    );
  }
  return (
    <Pressable
      className="shrink active:opacity-60"
      accessibilityRole="button"
      accessibilityLabel={revealed ? "Hide account label" : "Reveal account label"}
      onPress={() => setRevealed((current) => !current)}
    >
      <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
        · {revealed ? value : "••••••@••••••"}
      </Text>
    </Pressable>
  );
}

export function AccountLimits(props: {
  readonly driver: Driver;
  readonly label: string;
  readonly instanceLabel: string;
  readonly detail: string | undefined;
  readonly limits: ServerProvider["usageLimits"];
  readonly now: number;
  readonly first: boolean;
  readonly dense?: boolean;
  readonly trailing?: ReactNode;
  readonly footer?: ReactNode;
}) {
  const { limits, now, dense = false } = props;
  const color = useBarColor(props.driver);
  if (!limits) return null;
  const notice = limitsNotice(limits);
  const externalUsage = limits.externalUsage;
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
            <AccountInstanceLabel key={props.instanceLabel} value={props.instanceLabel} />
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
      {externalUsage ? (
        <Pressable
          accessibilityRole="link"
          className="min-h-11 justify-center"
          onPress={() => void Linking.openURL(externalUsage.url).catch(() => undefined)}
        >
          <Text className="text-sm font-t3-medium text-primary">Manage usage</Text>
        </Pressable>
      ) : null}
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

export function ResetCredits(props: {
  readonly environmentId: EnvironmentId;
  readonly input: ProviderConsumeResetCreditInput;
  readonly credits: ServerProviderResetCredits;
  readonly now: number;
  readonly dense?: boolean;
}) {
  const { environmentId, input, credits, now, dense = false } = props;
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
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
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
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
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    Dialog.alert(
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
          accessibilityState={{ disabled: busy || !canManageProviders }}
          disabled={busy || !canManageProviders}
          onPress={confirm}
          className={
            dense
              ? "rounded-full bg-subtle-strong px-2.5 py-1 disabled:opacity-[0.45]"
              : "min-h-[44px] justify-center rounded-full bg-subtle-strong px-3 py-1.5 disabled:opacity-[0.45]"
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
      {!canManageProviders ? (
        <Text className="text-xs text-foreground-tertiary">
          This connection cannot manage provider accounts.
        </Text>
      ) : null}
      {status ? <Text className="text-sm text-foreground">{status}</Text> : null}
    </View>
  );
}

const IDLE_ATOM = Atom.make(undefined);

export function useRefreshLimits(
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  active = false,
) {
  const registry = useContext(RegistryContext);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const now = useNowMinuteMs();
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const selected = [...presentations].filter(
    ([environmentId]) =>
      selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId),
  );
  const connectedIds = selected
    .filter(([, presentation]) => presentation.connection.phase === "connected")
    .map(([environmentId]) => environmentId);
  const connectedKey = environmentIdsKey(connectedIds);
  useAtomMount(active && connectedKey !== "" ? limitsAutoRefreshSetAtom(connectedKey) : IDLE_ATOM);
  const failedIds = new Set(
    useAtomValue(limitsRefreshFailuresAtom(environmentIdsKey(selected.map(([id]) => id)))),
  );
  const failedLabels = selected
    .filter(([environmentId]) => failedIds.has(environmentId))
    .map(([, presentation]) => presentation.entry.target.label);

  const refresh = (afterPending: boolean) =>
    Promise.all(
      connectedIds.map((environmentId) =>
        refreshEnvironmentLimits(registry, environmentId, { afterPending }),
      ),
    );
  // Android RefreshControl needs a true-to-false cycle to stop, even with nothing to probe.
  const refreshManually = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    await refresh(false).finally(() => {
      refreshingRef.current = false;
      setRefreshing(false);
    });
  };
  return {
    now,
    refreshing,
    failedLabels,
    refresh: refreshManually,
    refreshAfterEnable: () => refresh(true),
  };
}
