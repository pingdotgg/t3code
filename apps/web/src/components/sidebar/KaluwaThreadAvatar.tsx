// Fork: Kaluwa's project-folder tree. Sizes, colours and the status rings live in the
// "Kaluwa folder tree" block of index.css, tuned in a mockup and kept as plain CSS variables.
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

const PIP_STATUSES = new Set<KaluwaThreadAvatarStatus>([
  "approval",
  "woke",
  "input",
  "request",
  "failed",
  "done",
]);

export function KaluwaThreadAvatar(props: {
  readonly providerEntry: SidebarProviderEntry | null;
  readonly showInstanceBadge: boolean;
  readonly status: KaluwaThreadAvatarStatus | null;
  readonly recede: boolean;
  /** A sub-agent needs the user: a marker opposite the avatar's own pip. */
  readonly childAttention?: "failed" | "approval" | "input" | null | undefined;
}) {
  const { providerEntry, status } = props;
  return (
    <span
      aria-hidden
      className="kaluwa-av"
      data-kaluwa-status={status ?? "idle"}
      data-recede={props.recede || undefined}
    >
      {status ? <span className="kaluwa-av-ring" /> : null}
      {/* Only `transform` animates, so the spinner stays on the compositor. */}
      {status === "working" ? <span className="kaluwa-av-spin" /> : null}
      {providerEntry ? (
        <ProviderInstanceIcon
          driverKind={providerEntry.driverKind}
          displayName={providerEntry.displayName}
          accentColor={providerEntry.accentColor}
          acpRegistryAgentId={providerEntry.acpRegistryAgentId}
          acpRegistryIconUrl={providerEntry.acpRegistryIconUrl}
          showBadge={props.showInstanceBadge}
          size="compact"
          className="kaluwa-av-logo"
          iconClassName="kaluwa-av-icon"
          badgeClassName="kaluwa-av-badge"
        />
      ) : null}
      {status && PIP_STATUSES.has(status) ? <span className="kaluwa-av-pip" /> : null}
      {props.childAttention ? (
        <span className="kaluwa-av-subpip" data-kaluwa-status={props.childAttention} />
      ) : null}
    </span>
  );
}

/**
 * A folder thread's branch: an elbow from its folder's trunk into the row, and the trunk
 * running on below unless this is the folder's last thread.
 */
export function KaluwaFolderTreeLines() {
  return (
    <>
      <span aria-hidden className="kaluwa-tree-elbow" />
      <span aria-hidden className="kaluwa-tree-trunk" />
    </>
  );
}
