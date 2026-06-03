import { useWsConnectionStatus } from "~/rpc/wsConnectionState";

export function ConnectionStatusPill() {
  const status = useWsConnectionStatus();

  if (status.phase !== "connected") return null;

  const label = status.connectionLabel?.trim() || "T3 Server";

  return (
    <div className="md:hidden inline-flex items-center gap-1.5 self-start rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success-foreground">
      <span className="size-1.5 rounded-full bg-success-foreground/90" aria-hidden />
      <span className="truncate">Connected to {label}</span>
    </div>
  );
}
