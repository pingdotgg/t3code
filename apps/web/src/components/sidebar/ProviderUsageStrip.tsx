import type { ProviderInstanceId } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { type ComponentPropsWithRef, memo, useMemo } from "react";

import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { usePrimaryProviderQuota } from "../../state/providerQuota";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { DRIVER_OPTIONS } from "../settings/providerDriverMeta";
import { deriveVisibleOrderedProviderSettingsRows } from "../settings/ProviderSettingsPanel.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarMenuItem } from "../ui/sidebar";
import { formatDate } from "./ProviderQuotaDetails";
import {
  buildProviderUsageStripItems,
  providerUsageAriaLabel,
  type ProviderUsageStripItem,
} from "./ProviderUsageStrip.logic";

function ProviderUsageButton({
  item,
  className,
  type = "button",
  ...props
}: ComponentPropsWithRef<"button"> & { readonly item: ProviderUsageStripItem }) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[item.driver] ?? BotIcon;
  return (
    <button
      {...props}
      aria-label={providerUsageAriaLabel(item)}
      className={cn(
        "inline-flex h-6 w-[3.75rem] shrink-0 items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground active:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 motion-reduce:transform-none",
        className,
      )}
      type={type}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="w-7 text-center tabular-nums">
        {item.percentage === null ? "—" : `${item.percentage}%`}
      </span>
    </button>
  );
}

export function providerUsageTooltip(item: ProviderUsageStripItem): string {
  const label = providerUsageAriaLabel(item);
  if (item.snapshot?.lastSuccessfulReadAt) {
    return `${label}. Last successful read ${formatDate(item.snapshot.lastSuccessfulReadAt)}`;
  }
  return `${label}. No successful read is available`;
}

const ProviderUsageItem = memo(function ProviderUsageItem({
  item,
  onSelect,
}: {
  readonly item: ProviderUsageStripItem;
  readonly onSelect: (instanceId: ProviderInstanceId) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<ProviderUsageButton item={item} onClick={() => onSelect(item.instanceId)} />}
      />
      <TooltipPopup>{providerUsageTooltip(item)}</TooltipPopup>
    </Tooltip>
  );
});

export const ProviderUsageStripView = memo(function ProviderUsageStripView({
  items,
  onSelect,
}: {
  readonly items: ReadonlyArray<ProviderUsageStripItem>;
  readonly onSelect: (instanceId: ProviderInstanceId) => void;
}) {
  if (items.length === 0) return null;
  return (
    <SidebarMenuItem className="min-w-0">
      <div
        className="flex h-7 min-w-0 max-w-full items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-slot="provider-usage-strip"
      >
        {items.map((item) => (
          <ProviderUsageItem key={item.instanceId} item={item} onSelect={onSelect} />
        ))}
      </div>
    </SidebarMenuItem>
  );
});

export function ProviderUsageStrip({
  onSelect,
}: {
  readonly onSelect: (instanceId: ProviderInstanceId) => void;
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const config = primaryEnvironment?.serverConfig ?? null;
  const quota = usePrimaryProviderQuota();
  const rows = useMemo(
    () =>
      config === null
        ? []
        : deriveVisibleOrderedProviderSettingsRows({
            settings: config.settings,
            driverOrder: DRIVER_OPTIONS.map((option) => option.value),
            serverProviders: config.providers,
          }),
    [config],
  );
  const items = useMemo(
    () => buildProviderUsageStripItems({ rows, summary: quota.summary }),
    [quota.summary, rows],
  );

  return <ProviderUsageStripView items={items} onSelect={onSelect} />;
}
