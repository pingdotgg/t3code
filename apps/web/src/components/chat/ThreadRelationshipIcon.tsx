import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { BotIcon, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** Shared by lineage and timeline links, including the provider glyph and status badge. */
export function ThreadRelationshipIcon({
  driver,
  provider,
  status,
  pulse = false,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  status: string | null;
  pulse?: boolean;
  fallbackIcon?: LucideIcon;
}) {
  const running = status === "running" || status === "in_progress";
  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  return (
    <span
      ref={pulse && running ? observeVisibleAnimation : undefined}
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center",
        pulse &&
          running &&
          "motion-safe:animate-status-pulse [animation-play-state:var(--visible-animation-state,paused)]",
      )}
    >
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}
          acpRegistryIconUrl={provider?.iconUrl}
          iconClassName={iconClassName}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={iconClassName} />
      )}
      <span
        className={cn(
          "absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-card",
          running || status === "pending" || status === "waiting"
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
