import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { BotIcon, type LucideIcon } from "lucide-react";
import { translateDynamic } from "../../i18nCore";
import { cn } from "../../lib/utils";
import {
  hasInstanceBadge,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function threadRelationshipStatusLabel(status: string | null): string {
  switch (status) {
    case "preparing":
    case "starting":
      return translateDynamic("chat:relationshipStatus.starting");
    case "running":
    case "in_progress":
      return translateDynamic("chat:relationshipStatus.running");
    case "pending":
    case "queued":
      return translateDynamic("chat:relationshipStatus.queued");
    case "waiting":
    case "blocked":
      return translateDynamic("chat:relationshipStatus.waiting");
    case "completed":
      return translateDynamic("chat:relationshipStatus.done");
    case "failed":
    case "error":
      return translateDynamic("chat:relationshipStatus.failed");
    case "cancelled":
    case "interrupted":
      return translateDynamic("chat:relationshipStatus.stopped");
    case "rolled_back":
      return translateDynamic("chat:relationshipStatus.reverted");
    case "resolved_native":
      return translateDynamic("chat:relationshipStatus.resolvedNative");
    case "resolved_portable":
      return translateDynamic("chat:relationshipStatus.resolvedPortable");
    case "consumed":
      return translateDynamic("chat:relationshipStatus.consumed");
    case "superseded":
      return translateDynamic("chat:relationshipStatus.superseded");
    case "idle":
      return translateDynamic("chat:relationshipStatus.idle");
    default:
      return translateDynamic("chat:relationshipStatus.unknown");
  }
}

export function ThreadRelationshipIcon({
  driver,
  provider,
  providerEntries = [],
  anyInstanceBadge = hasInstanceBadge(providerEntries),
  status,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  providerEntries?: ReadonlyArray<ProviderInstanceEntry>;
  /** For rows that can't take `providerEntries` but sit in the same list as rows that do. */
  anyInstanceBadge?: boolean;
  status: string | null;
  fallbackIcon?: LucideIcon;
}) {
  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  const entry = driver
    ? providerEntries.find((candidate) => candidate.instanceId === provider?.instanceId)
    : undefined;
  const showInstanceBadge = entry !== undefined && shouldShowInstanceBadge(entry, providerEntries);
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={entry?.displayName ?? provider?.displayName ?? driver}
          accentColor={entry?.accentColor}
          acpRegistryAgentId={entry?.acpRegistryAgentId}
          acpRegistryIconUrl={entry?.acpRegistryIconUrl ?? provider?.iconUrl}
          showBadge={showInstanceBadge}
          size="compact"
          iconClassName={iconClassName}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={iconClassName} />
      )}
      <span
        className={cn(
          "absolute -right-1 size-2 rounded-full border-2 border-card",
          anyInstanceBadge ? "-top-1" : "-bottom-1",
          status === "running" ||
            status === "in_progress" ||
            status === "pending" ||
            status === "waiting"
            ? "bg-info"
            : status === "failed" || status === "error"
              ? "bg-destructive"
              : status === "completed"
                ? "bg-success"
                : "bg-muted-foreground/45",
        )}
        aria-hidden="true"
      />
    </span>
  );
}
