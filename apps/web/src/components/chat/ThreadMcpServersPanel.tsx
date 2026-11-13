import type { EnvironmentId, ThreadId, ThreadMcpServer } from "@t3tools/contracts";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, PlugIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { mcpAppEnvironment } from "../../state/mcpApps";
import { useEnvironmentQuery } from "../../state/query";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/** Logo slots in the collapsed strip; past this the last slot becomes a `+N` chip. */
const STRIP_SLOTS = 7;

const STATUS_ORDER: Record<ThreadMcpServer["status"], number> = {
  connected: 0,
  pending: 1,
  disabled: 2,
  "needs-auth": 3,
  failed: 4,
};

const STATUS_LABEL: Record<ThreadMcpServer["status"], string> = {
  connected: "Connected",
  pending: "Connecting",
  disabled: "Disabled",
  "needs-auth": "Needs sign-in",
  failed: "Failed to connect",
};

function sortThreadMcpServers(servers: ReadonlyArray<ThreadMcpServer>) {
  return servers.toSorted(
    (left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || left.name.localeCompare(right.name),
  );
}

function threadMcpServerSummary(servers: ReadonlyArray<ThreadMcpServer>) {
  const count = (status: ThreadMcpServer["status"]) =>
    servers.filter((server) => server.status === status).length;
  return [
    `${count("connected")} on`,
    count("needs-auth") > 0 ? `${count("needs-auth")} sign-in` : null,
    count("failed") > 0 ? `${count("failed")} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

interface ThreadMcpServersPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Changes when a run starts or settles, which is when a session's servers can change. */
  readonly activeRunId: string | null;
}

/** MCP servers the thread's live provider session can use. Hidden while it reports none. */
export function ThreadMcpServersPanel(props: ThreadMcpServersPanelProps) {
  return <ThreadMcpServersList key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function ThreadMcpServersList(props: ThreadMcpServersPanelProps) {
  const query = useEnvironmentQuery(
    mcpAppEnvironment.listServers({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const [expanded, setExpanded] = useState(false);
  const refresh = query.refresh;
  const lastRunId = useRef(props.activeRunId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches server state when a run starts or settles
  useEffect(() => {
    if (lastRunId.current === props.activeRunId) return;
    lastRunId.current = props.activeRunId;
    refresh();
  }, [props.activeRunId, refresh]);

  const servers = sortThreadMcpServers(query.data?.servers ?? []);
  if (servers.length === 0) return null;
  const overflow = servers.length > STRIP_SLOTS;
  const stripServers = overflow ? servers.slice(0, STRIP_SLOTS - 1) : servers;

  return (
    <ThreadDetailsSection
      headingId="thread-details-mcp-heading"
      title="MCP servers"
      showHeading={false}
    >
      <div className="flex flex-col">
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <PlugIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            MCP
          </span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
            {threadMcpServerSummary(servers)}
          </span>
          {expanded ? (
            <ChevronDownIcon aria-hidden className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
          ) : (
            <ChevronRightIcon aria-hidden className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
          )}
        </ThreadDetailsControl>

        {expanded ? (
          <ul className="m-0 max-h-[300px] list-none overflow-y-auto p-0">
            {servers.map((server) => (
              <li key={server.name} className="flex h-8 items-center gap-2.5 px-2.5">
                <McpServerLogo server={server} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm font-medium",
                    server.status === "connected" ? "text-foreground/80" : "text-muted-foreground",
                  )}
                >
                  {server.name}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                  {server.status === "connected"
                    ? `${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`
                    : STATUS_LABEL[server.status]}
                </span>
                {server.status === "connected" ? (
                  <CheckIcon aria-label="Connected" className="size-3.5 shrink-0 text-success" />
                ) : (
                  <span aria-hidden className="size-3.5 shrink-0" />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden px-2.5 pb-0.5">
            {stripServers.map((server) => (
              <Tooltip key={server.name}>
                <TooltipTrigger delay={200} render={<span className="inline-flex shrink-0" />}>
                  <McpServerLogo server={server} />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {server.name}
                  {server.status === "connected" ? "" : ` · ${STATUS_LABEL[server.status]}`}
                </TooltipPopup>
              </Tooltip>
            ))}
            {overflow ? (
              <ThreadDetailsControl
                size="xs"
                variant="ghost"
                part="meta"
                aria-label={`Show all ${servers.length} MCP servers`}
                onClick={() => setExpanded(true)}
              >
                +{servers.length - stripServers.length}
              </ThreadDetailsControl>
            ) : null}
          </div>
        )}
      </div>
    </ThreadDetailsSection>
  );
}

const failedFaviconOrigins = new Set<string>();

const McpServerLogo = memo(function McpServerLogo({ server }: { server: ThreadMcpServer }) {
  const [failed, setFailed] = useState(false);
  const active = server.status === "connected";
  const faviconUrl =
    server.origin === undefined || failed || failedFaviconOrigins.has(server.origin)
      ? null
      : faviconUrlForOrigin(server.origin);
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md select-none",
        active ? "bg-secondary" : "opacity-45 grayscale",
      )}
    >
      {faviconUrl === null ? (
        <span className="text-2xs font-semibold text-muted-foreground uppercase">
          {server.name.replace(/^[^a-z0-9]+/i, "").charAt(0) || "?"}
        </span>
      ) : (
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className="size-3.5 rounded-sm"
          onError={() => {
            if (server.origin !== undefined) failedFaviconOrigins.add(server.origin);
            setFailed(true);
          }}
        />
      )}
    </span>
  );
});
