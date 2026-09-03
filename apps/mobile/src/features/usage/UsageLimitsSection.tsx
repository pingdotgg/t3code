import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  collectLimitsGroups,
  elapsedShare,
  formatResetsIn,
  limitsNotice,
  paceOf,
  providerLimitsLabel,
} from "@t3tools/shared/usageLimits";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { environmentPresentations } from "../../state/presentation";
import { SettingsSection } from "../settings/components/SettingsSection";

const PACE_LABEL = { ahead: "ahead of pace", on: "on pace", under: "under pace" } as const;

/**
 * One window as a bar spanning its whole duration: the fill is quota spent,
 * the hairline is how far into the window the clock is.
 */
function WindowBar(props: { readonly window: ServerProviderUsageWindow; readonly now: number }) {
  const { window, now } = props;
  const used = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
  const elapsed = elapsedShare(window, now);
  const pace = paceOf(window, now);
  const resetsIn = formatResetsIn(window, now);
  const detail = [pace ? PACE_LABEL[pace] : null, resetsIn].filter(Boolean).join(" · ");
  return (
    <View className="gap-1.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-base text-foreground">{window.label}</Text>
        <Text className="text-base tabular-nums text-foreground">{used}% used</Text>
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
            style={{ flex: used }}
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
      {detail ? <Text className="text-xs text-foreground-tertiary">{detail}</Text> : null}
    </View>
  );
}

function ProviderLimits(props: {
  readonly provider: ServerProvider;
  readonly now: number;
  readonly first: boolean;
}) {
  const { provider, now } = props;
  const limits = provider.usageLimits;
  if (!limits) return null;
  const notice = limitsNotice(limits);
  const label = providerLimitsLabel(provider, () => undefined);
  return (
    <View className={props.first ? "gap-3 p-4" : "gap-3 border-t border-border-subtle p-4"}>
      <View className="flex-row items-baseline gap-2">
        <Text className="text-lg text-foreground">{label}</Text>
        {provider.auth.label ? (
          <Text className="text-sm text-foreground-muted">{provider.auth.label}</Text>
        ) : null}
      </View>
      {notice ? (
        <Text className="text-sm text-foreground-muted">{notice}</Text>
      ) : (
        limits.windows.map((window) => <WindowBar key={window.id} window={window} now={now} />)
      )}
    </View>
  );
}

/**
 * Subscription quota windows from every connected environment's providers,
 * read from the config each environment already streams. Countdowns anchor to
 * render time rather than ticking.
 */
export function UsageLimitsSection() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const groups = collectLimitsGroups(presentations);
  const now = Date.now();
  if (groups.length === 0) return null;

  return (
    <>
      {groups.map((group) => (
        <SettingsSection
          key={group.environmentId}
          title={group.environmentLabel ? `Limits · ${group.environmentLabel}` : "Limits"}
          card
        >
          {group.providers.map((provider, index) => (
            <ProviderLimits
              key={provider.instanceId}
              provider={provider}
              now={now}
              first={index === 0}
            />
          ))}
        </SettingsSection>
      ))}
    </>
  );
}
