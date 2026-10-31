import { ArrowUpRight } from "lucide-react";

import { Button } from "~/components/ui/button";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  server: PreviewableServer;
  onOpen: () => void;
}

/** One live local server: a live dot, its address, the owning process, and Open. */
export function PreviewLocalServerCard({ server, onOpen }: Props) {
  const address = `${server.host}:${server.port}`;
  return (
    <div className="flex items-center gap-2.5 rounded-card surface-card-settings px-3 py-2.5">
      <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-success" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-body text-foreground">{address}</span>
        <span className="truncate text-caption text-dim-foreground">{describeServer(server)}</span>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        aria-label={`Open ${address}`}
        onClick={onOpen}
      >
        <ArrowUpRight />
        Open
      </Button>
    </div>
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  return "Listening";
}
