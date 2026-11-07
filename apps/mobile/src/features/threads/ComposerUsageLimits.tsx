import { resetAvailability } from "@t3tools/shared/usageLimits";
import type { EnvironmentId, UsageLimitsReport } from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { AccountLimits, ResetCredits, ResetStatus } from "../usage/UsageLimitsSection";

const DRIVER_LABEL: Partial<Record<string, string>> = { codex: "Codex", claudeAgent: "Claude" };

export function ComposerUsageLimits({
  report,
  environmentId,
  maxHeight,
  onClose,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
  readonly maxHeight: number;
  readonly onClose: () => void;
}) {
  const now = Date.parse(report.createdAt);
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
      <ScrollView bounces={false} showsVerticalScrollIndicator={false} style={{ maxHeight }}>
        {report.accounts.map((account, index) => {
          // The hub's count is read-only, so a row with its reset redeems only by explicit input.
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId && !account.limits.atLimitReset
              ? { instanceId: account.instanceId }
              : undefined);
          const driverLabel = DRIVER_LABEL[account.driver] ?? String(account.driver);
          // A failed read says nothing about resets, so it cannot show a stale yes.
          const resets = limitsNotice(account.limits) ? null : resetAvailability(account.limits);
          const redeemCredits =
            resetCreditInput && account.limits.resetCredits ? (
              <ResetCredits
                dense
                environmentId={environmentId}
                input={resetCreditInput}
                credits={account.limits.resetCredits}
                now={now}
              />
            ) : null;
          return (
            <AccountLimits
              key={account.id}
              dense
              first={index === 0}
              driver={account.driver}
              accentColor={account.accentColor}
              label={driverLabel}
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
                resets ? (
                  <ResetStatus dense resets={resets} now={now} redeem={redeemCredits} />
                ) : (
                  redeemCredits
                )
              }
            />
          );
        })}
        {report.accounts.length === 0 ? (
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
