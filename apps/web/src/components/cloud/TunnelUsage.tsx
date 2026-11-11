import { T3CHAT_PLAN_TUNNEL_LIMITS } from "@t3tools/contracts/relay";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ManagedTunnelUpgrade } from "../../cloud/managedRelayState";
import { cn } from "../../lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

// Above this, one slot per tunnel is too thin to read, so the bar fills instead.
const MAX_SEGMENTS = 10;

export const T3CHAT_SUBSCRIPTION_URL = "https://t3.chat/settings/subscription";

export function tunnelUpgradeCopy(upgrade: Exclude<ManagedTunnelUpgrade, null>): string {
  const { pro, premier } = T3CHAT_PLAN_TUNNEL_LIMITS;
  switch (upgrade) {
    case "link":
      return `Link T3 Chat Pro for up to ${pro} tunnels, or Premier for up to ${premier}.`;
    case "pro":
      return `Upgrade to T3 Chat Pro for up to ${pro} tunnels, or Premier for up to ${premier}.`;
    case "premier":
      return `Upgrade to T3 Chat Premier for up to ${premier} tunnels.`;
  }
}

/** "2 of 3 tunnels in use" with one bar slot per tunnel. */
export function TunnelUsageMeter({
  used,
  limit,
  action,
  className,
}: {
  readonly used: number;
  readonly limit: number;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  const full = used >= limit;
  const fill = full ? "bg-warning" : "bg-foreground/72";
  return (
    <div className={cn("flex max-w-sm flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className={cn("tabular-nums", full ? "text-warning-foreground" : "text-foreground")}>
          {used} of {limit} tunnels in use
        </span>
        {action}
      </div>
      <div
        role="meter"
        aria-label="T3 Connect tunnels in use"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="flex h-1.5 gap-1"
      >
        {limit <= MAX_SEGMENTS ? (
          Array.from({ length: limit }, (_, index) => (
            <span
              key={index}
              className={cn("flex-1 rounded-full", index < used ? fill : "bg-muted")}
            />
          ))
        ) : (
          <span className="flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn("block h-full rounded-full", fill)}
              style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
            />
          </span>
        )}
      </div>
    </div>
  );
}

/** Shown when the relay refuses a new tunnel because the account is at its cap. */
export function TunnelLimitAlert({
  upgrade,
  onLinkT3Chat,
  onManageTunnels,
}: {
  readonly upgrade: ManagedTunnelUpgrade;
  readonly onLinkT3Chat: (() => void) | null;
  readonly onManageTunnels: (() => void) | null;
}) {
  const action =
    upgrade === "link" && onLinkT3Chat ? (
      <Button size="sm" onClick={onLinkT3Chat}>
        Link T3 Chat
      </Button>
    ) : upgrade === "pro" || upgrade === "premier" ? (
      <Button
        size="sm"
        render={<a href={T3CHAT_SUBSCRIPTION_URL} target="_blank" rel="noopener noreferrer" />}
      >
        Upgrade on T3 Chat
      </Button>
    ) : onManageTunnels ? (
      <Button size="sm" variant="outline" onClick={onManageTunnels}>
        Manage tunnels
      </Button>
    ) : null;
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>You&apos;re out of tunnels (they cost us money).</AlertTitle>
      <AlertDescription>
        {upgrade === "link"
          ? "Switch to Tailscale or get more tunnels by linking your T3 Chat sub (sorry!)"
          : upgrade
            ? "Switch to Tailscale or get more tunnels by upgrading your T3 Chat sub (sorry!)"
            : "Switch to Tailscale or deregister an environment you no longer use (sorry!)"}
      </AlertDescription>
      {action ? <AlertAction>{action}</AlertAction> : null}
    </Alert>
  );
}
