import { cn } from "~/lib/utils";

import { BrowserMockup } from "./BrowserMockup";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ server, onOpen }: Props) {
  const subtitle = describeServer(server);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-2.5 text-left transition-colors",
        "hover:border-border hover:bg-accent/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      )}
    >
      <BrowserMockup className="size-7 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {server.host}:{server.port}
        </span>
        <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
      </div>
      {server.listening ? <PulsingDot /> : <DimDot />}
    </button>
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  if (server.listening) return "Listening";
  if (server.source === "configured") return "Configured";
  return "Recently seen";
}

function PulsingDot() {
  return (
    <span aria-label="Listening" className="relative inline-flex size-2 shrink-0">
      <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-success" />
    </span>
  );
}

function DimDot() {
  return (
    <span
      aria-label="Not currently listening"
      className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
    />
  );
}
