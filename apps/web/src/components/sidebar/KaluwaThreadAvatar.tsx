// Fork: Kaluwa's folder rows lead with the thread's provider, ringed in its status colour.
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import type { SidebarProviderEntry } from "./SidebarThreadRow";

type KaluwaThreadAvatarStatus =
  | "working"
  | "waiting"
  | "input"
  | "request"
  | "approval"
  | "failed"
  | "done"
  | "woke";

/** Static rings only: a spinning one would repaint every frame for each running thread. */
const RING_CLASS_NAME: Record<KaluwaThreadAvatarStatus, string> = {
  working: "border-dashed border-info-foreground",
  waiting: "border-dotted border-muted-foreground",
  input: "border-indigo-600 dark:border-indigo-300",
  request: "border-guest-foreground",
  approval: "border-warning-foreground",
  failed: "border-error-foreground",
  done: "border-success-foreground",
  woke: "border-warning-foreground",
};

export function KaluwaThreadAvatar(props: {
  readonly providerEntry: SidebarProviderEntry | null;
  readonly showInstanceBadge: boolean;
  readonly status: KaluwaThreadAvatarStatus | null;
  readonly recede: boolean;
}) {
  const { providerEntry, status } = props;
  return (
    <span
      aria-hidden
      className="relative flex size-4 shrink-0 items-center justify-center"
      data-thread-status={status ?? undefined}
    >
      {status ? (
        <span
          className={cn(
            "pointer-events-none absolute -inset-1 rounded-full border-2",
            RING_CLASS_NAME[status],
          )}
        />
      ) : null}
      {providerEntry ? (
        <ProviderInstanceIcon
          driverKind={providerEntry.driverKind}
          displayName={providerEntry.displayName}
          accentColor={providerEntry.accentColor}
          acpRegistryAgentId={providerEntry.acpRegistryAgentId}
          acpRegistryIconUrl={providerEntry.acpRegistryIconUrl}
          showBadge={props.showInstanceBadge}
          size="compact"
          className="z-0"
          iconClassName={cn(
            "size-3.5 transition-opacity",
            props.recede && status === null && "opacity-60",
          )}
          badgeClassName="right-[-0.3125rem] bottom-[-0.3125rem] h-2.5 min-w-2.5 px-px text-5xs tracking-tight"
          indicatorBackground="var(--sidebar)"
        />
      ) : null}
    </span>
  );
}
