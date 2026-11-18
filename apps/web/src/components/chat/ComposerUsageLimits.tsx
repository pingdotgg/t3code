import type { EnvironmentId, UsageLimitsReport } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { msg, T, useGT, useMessages } from "gt-react";
import { GaugeIcon } from "lucide-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { ensureLocalApi } from "../../localApi";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (!account.instanceId) return account.label;
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  return instance && instance.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${instance}`
    : driver;
}

function AccountSummary({ account }: { readonly account: UsageLimitsReport["accounts"][number] }) {
  const gt = useGT();
  const label = accountLabel(account);
  return (
    <>
      {label.includes("@") ? (
        <RedactedSensitiveText
          key={label}
          value={label}
          ariaLabel={gt("Toggle account label visibility")}
          revealTooltip={gt("Click to reveal account")}
          hideTooltip={gt("Click to hide account")}
          className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
        />
      ) : (
        label
      )}
      {account.plan ? ` · ${account.plan}` : null}
    </>
  );
}

export function usageLimitsBannerItem(
  id: string,
  report: UsageLimitsReport,
  environmentId: EnvironmentId,
  onDismiss: () => void,
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const [first] = report.accounts;
  const single = report.accounts.length === 1 && first ? first : null;
  const summary = single ? (
    <AccountSummary account={single} />
  ) : (
    resolve(
      msg("{count, plural, one {{count} account} other {{count} accounts}}", {
        count: report.accounts.length,
      }),
    )
  );
  return {
    id,
    variant: "info",
    icon: <GaugeIcon />,
    title: resolve(msg("Usage limits")),
    description: summary,
    dismissLabel: resolve(msg("Dismiss usage limits")),
    onDismiss,
    children: <UsageLimitsBannerBody report={report} environmentId={environmentId} />,
  };
}

export function modelFallbackBannerItem(
  {
    fallbackModelName,
    fallbackProviderName,
    defaultProviderName,
    defaultModelName,
    resetsAt,
    timestampFormat,
    onUseDefault,
    onDismiss,
  }: {
    readonly fallbackModelName: string;
    readonly fallbackProviderName: string;
    readonly defaultProviderName: string;
    readonly defaultModelName: string;
    readonly resetsAt: string | null;
    readonly timestampFormat: TimestampFormat;
    readonly onUseDefault: () => void;
    readonly onDismiss: () => void;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  return {
    id: "fallback-model",
    variant: "info",
    icon: <GaugeIcon />,
    title: resolve(msg("Using {model} on {provider}", { model: fallbackModelName, provider: fallbackProviderName })),
    description: resetsAt
      ? resolve(
          msg("{provider} is out of usage · resets {time}", {
            provider: defaultProviderName,
            time: formatUpcomingTimestamp(
              resetsAt,
              timestampFormat,
              Date.now(),
              undefined,
              resolve,
            ),
          }),
        )
      : resolve(msg("{provider} is out of usage", { provider: defaultProviderName })),
    actions: (
      <Button size="xs" variant="ghost" onClick={onUseDefault}>
        {resolve(msg("Use {model}", { model: defaultModelName }))}
      </Button>
    ),
    dismissLabel: resolve(msg("Dismiss fallback model notice")),
    onDismiss,
  };
}

function UsageLimitsBannerBody({
  report,
  environmentId,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
}) {
  const messages = useMessages();
  const now = Date.parse(report.createdAt);
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
        {report.accounts.map((account) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const notice = limitsNotice(account.limits, messages);
          const externalUsage = account.limits.externalUsage;
          return (
            <div key={account.id} className="flex min-w-0 flex-col gap-1">
              {report.accounts.length > 1 ? (
                <span className="truncate text-xs text-muted-foreground">
                  <AccountSummary account={account} />
                </span>
              ) : null}
              {notice ? (
                <span className="text-xs text-muted-foreground">{notice}</span>
              ) : (
                <LimitWindows
                  compact
                  driver={account.driver}
                  accentColor={account.accentColor}
                  windows={account.limits.windows}
                  now={now}
                />
              )}
              {externalUsage ? (
                <Button
                  size="sm"
                  variant="link"
                  className="self-start"
                  onClick={() => void ensureLocalApi().shell.openExternal(externalUsage.url)}
                >
                  <T>Manage usage</T>
                </Button>
              ) : null}
              {resetCreditInput && account.limits.resetCredits ? (
                <ResetCredits
                  environmentId={environmentId}
                  input={resetCreditInput}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              ) : null}
            </div>
          );
        })}
        {report.notices.map((notice) => (
          <span key={notice} className="text-xs text-muted-foreground">
            {notice}
          </span>
        ))}
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}
