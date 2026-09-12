import type { EnvironmentId, UsageLimitsReport } from "@t3tools/contracts";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { AccountLimits, ResetCredits } from "../usage/UsageLimitsSection";

const DRIVER_LABEL: Partial<Record<string, string>> = { codex: "Codex", claudeAgent: "Claude" };

/**
 * The /usage-limits result, docked above the composer. It is the Usage → Limits
 * card one size down, so the two read as the same thing. The surface is opaque
 * because nothing blurs the feed behind it.
 */
export function ComposerUsageLimits({
  report,
  environmentId,
  onClose,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const now = Date.parse(report.createdAt);
  const { height } = useWindowDimensions();
  const close = (
    <Pressable
      accessibilityLabel="Dismiss usage limits"
      accessibilityRole="button"
      hitSlop={12}
      onPress={onClose}
      className="-me-1 p-1 active:opacity-60"
    >
      <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
    </Pressable>
  );
  return (
    <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
      <ScrollView
        bounces={false}
        showsVerticalScrollIndicator={false}
        style={{ maxHeight: Math.round(height * 0.4) }}
      >
        {report.accounts.map((account, index) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const driverLabel = DRIVER_LABEL[account.driver] ?? String(account.driver);
          return (
            <AccountLimits
              key={account.id}
              dense
              first={index === 0}
              driver={account.driver}
              label={driverLabel}
              // Siblings need telling apart: a custom instance without a name shows its
              // id, and a pooled account shows its hub and account id.
              instanceLabel={
                account.instanceId
                  ? account.displayName?.trim() ||
                    (String(account.instanceId) !== String(account.driver)
                      ? account.instanceId
                      : driverLabel)
                  : account.label
              }
              detail={account.plan}
              limits={account.limits}
              now={now}
              trailing={index === 0 ? close : undefined}
              footer={
                resetCreditInput && account.limits.resetCredits ? (
                  <ResetCredits
                    dense
                    environmentId={environmentId}
                    input={resetCreditInput}
                    credits={account.limits.resetCredits}
                    now={now}
                  />
                ) : undefined
              }
            />
          );
        })}
        {report.accounts.length === 0 ? (
          // Nothing but notices, so the close control needs a row of its own.
          <View className="flex-row items-center gap-3 px-4 pt-3">
            <Text className="min-w-0 flex-1 text-base text-foreground">Usage limits</Text>
            {close}
          </View>
        ) : null}
        {report.notices.map((notice) => (
          <Text
            key={notice}
            className={
              report.accounts.length === 0
                ? "px-4 py-3 text-xs text-foreground-muted"
                : "border-t border-border-subtle px-4 py-3 text-xs text-foreground-muted"
            }
          >
            {notice}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}
