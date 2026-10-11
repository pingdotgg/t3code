import {
  AuthProvidersManageScope,
  type EnvironmentId,
  mcpServerTransportSummary,
  type McpServerTool,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { useAfterDelay } from "../../hooks/useAfterDelay";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsGroup } from "./SettingsGroup";
import { TruncatedText } from "./TruncatedText";
import type { McpServerRow } from "./toolsSettings.logic";
import { useEscapeToList } from "./useEscapeToList";

/** A start that finishes sooner than this shows no placeholder at all. */
const SKELETON_DELAY_MS = 150;

/**
 * One MCP server: what it is, its switch and actions, then the tools it
 * offers, read by starting it as an agent would. The settings header names
 * it and leads back to the list. `row` is null for T3 Code's own server.
 */
export function McpServerDetail({
  name,
  row,
  environmentId,
  cwd,
  canSwitch,
  onEnabledChange,
  onEdit,
  onRemove,
  onReset,
  onBack,
}: {
  name: string;
  row: McpServerRow | null;
  environmentId: EnvironmentId;
  /** The project checkout whose settings apply, or null for the environment's. */
  cwd: string | null;
  canSwitch: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onEdit: (() => void) | null;
  onRemove: (() => void) | null;
  onReset: (() => void) | null;
  onBack: () => void;
}) {
  useEscapeToList(onBack);
  const canList = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const query = useEnvironmentQuery(
    canList
      ? serverEnvironment.listMcpServerTools({
          environmentId,
          input: { name, ...(cwd === null ? {} : { cwd }) },
        })
      : null,
  );
  // An edit while the page is open lists the server again as it now starts.
  const transportKey = row === null ? "" : JSON.stringify(row.config.transport);
  const listedFor = useRef(transportKey);
  const { refresh } = query;
  useEffect(() => {
    if (listedFor.current === transportKey) return;
    listedFor.current = transportKey;
    refresh();
  }, [refresh, transportKey]);

  const tools = query.data?.tools ?? null;
  const showSkeleton = useAfterDelay(
    canList && tools === null && query.error === null,
    SKELETON_DELAY_MS,
  );
  const serverInfo = query.data?.serverInfo;
  const enabled = row?.config.enabled ?? true;

  return (
    <section aria-label={`${name} details`} className="min-w-0 space-y-4 px-3 sm:px-4">
      <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 px-3 py-3 sm:px-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 flex-wrap items-center gap-1.5 text-lg font-semibold break-words">
              <span className={cn("min-w-0", !enabled && "text-muted-foreground")}>{name}</span>
              <Badge variant="outline" size="sm">
                {row === null
                  ? "Built in"
                  : row.config.transport.type === "stdio"
                    ? "Command"
                    : "URL"}
              </Badge>
              {row?.replacesEnvironment ? (
                <Badge variant="info" size="sm">
                  Replaces environment's
                </Badge>
              ) : null}
              {row?.origin === "project-switch" ? (
                <Badge variant="info" size="sm">
                  {enabled ? "On" : "Off"} for this project
                </Badge>
              ) : null}
            </h2>
            {row === null ? (
              <p className="mt-1 text-sm text-muted-foreground">
                T3 Code's own tools: threads, tasks, the browser and devices. Every agent session
                gets this server; browser and device tools follow their settings.
              </p>
            ) : (
              <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                {mcpServerTransportSummary(row.config.transport)}
              </p>
            )}
          </div>
          {row === null ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Switch aria-label={`${name} server`} checked disabled />
              </TooltipTrigger>
              <TooltipPopup side="top">Every agent session gets this server.</TooltipPopup>
            </Tooltip>
          ) : (
            <Switch
              aria-label={`${name} server`}
              checked={enabled}
              disabled={!canSwitch}
              onCheckedChange={onEnabledChange}
            />
          )}
        </div>
        {onReset !== null || onEdit !== null || onRemove !== null ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {onReset !== null ? (
              <Button size="xs" variant="ghost" onClick={onReset} disabled={!canSwitch}>
                Reset
              </Button>
            ) : null}
            {onEdit !== null ? (
              <Button size="xs" variant="outline" onClick={onEdit}>
                Edit
              </Button>
            ) : null}
            {onRemove !== null ? (
              <Button size="xs" variant="destructive-outline" onClick={onRemove}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <section className="space-y-2.5">
        <div className="flex min-h-7 items-center gap-2">
          <h3 className="shrink-0 text-sm font-normal text-foreground/70">
            Tools{tools === null ? "" : ` · ${tools.length}`}
          </h3>
          {serverInfo !== undefined ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {serverInfo.name}
              {serverInfo.version === undefined ? "" : ` ${serverInfo.version}`}
            </span>
          ) : null}
          <span className="flex-1" />
          {row !== null && canList ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={query.isPending ? "Listing tools" : "List tools again"}
                    disabled={query.isPending}
                    onClick={refresh}
                  />
                }
              >
                <RefreshIcon refreshing={query.isPending} />
              </TooltipTrigger>
              <TooltipPopup side="top">Start the server again and list its tools</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        {!canList ? (
          <SettingsGroup>
            <p className="px-3 py-5 text-sm text-muted-foreground sm:px-4">
              Listing a server's tools starts it, which needs permission to manage providers on this
              environment.
            </p>
          </SettingsGroup>
        ) : query.error !== null ? (
          <SettingsGroup>
            <div className="flex flex-wrap items-center gap-3 px-3 py-4 sm:px-4">
              <p className="min-w-0 flex-1 text-sm text-destructive-foreground">
                {tools === null
                  ? "Couldn't list this server's tools. "
                  : "Couldn't list them again. "}
                {query.error}
              </p>
              <Button size="xs" variant="outline" disabled={query.isPending} onClick={refresh}>
                Retry
              </Button>
            </div>
          </SettingsGroup>
        ) : null}
        {tools !== null ? (
          <SettingsGroup>
            {tools.length === 0 ? (
              <p className="px-3 py-5 text-sm text-muted-foreground sm:px-4">
                This server offers no tools.
              </p>
            ) : (
              <ul className="divide-y divide-border/50">
                {tools.map((tool) => (
                  <McpToolItem key={tool.name} tool={tool} />
                ))}
              </ul>
            )}
          </SettingsGroup>
        ) : showSkeleton ? (
          <ToolsSkeleton />
        ) : null}
      </section>
    </section>
  );
}

/** A tool on one dense line; it opens to its full description and parameters. */
const McpToolItem = memo(function McpToolItem({ tool }: { tool: McpServerTool }) {
  const [open, setOpen] = useState(false);
  const count = tool.parameters.length;
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-mono text-sm font-medium">{tool.name}</span>
            {tool.title !== undefined && tool.title !== tool.name ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{tool.title}</span>
            ) : null}
          </span>
          {open ? null : (
            <TruncatedText
              className="text-xs text-muted-foreground"
              text={tool.description ?? "No description."}
            />
          )}
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {count === 0 ? "No parameters" : count === 1 ? "1 parameter" : `${count} parameters`}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="space-y-2.5 px-3 pb-3 sm:px-4">
          <p className="text-xs whitespace-pre-line text-muted-foreground">
            {tool.description ?? "No description."}
          </p>
          {count === 0 ? (
            <p className="text-xs text-muted-foreground">Takes no parameters.</p>
          ) : (
            <dl className="divide-y divide-border/50 rounded-lg border border-border/60">
              {tool.parameters.map((parameter) => (
                <div
                  key={parameter.name}
                  className="grid gap-x-4 gap-y-0.5 px-3 py-1.5 sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)]"
                >
                  <dt className="flex min-w-0 items-center gap-1.5">
                    <code className="truncate font-mono text-xs text-foreground">
                      {parameter.name}
                    </code>
                    {parameter.required ? (
                      <Badge variant="outline" size="sm">
                        Required
                      </Badge>
                    ) : null}
                  </dt>
                  <dd className="min-w-0 text-xs break-words text-muted-foreground">
                    {parameter.type !== undefined ? (
                      <code className="font-mono text-foreground/80">{parameter.type}</code>
                    ) : null}
                    {parameter.type !== undefined && parameter.description !== undefined
                      ? " · "
                      : null}
                    {parameter.description}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : null}
    </li>
  );
});

/** Placeholder rows while the server starts, laid out like the list they stand in for. */
function ToolsSkeleton() {
  return (
    <SettingsGroup aria-hidden>
      <ul className="divide-y divide-border/50">
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
            <span className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-3/4" />
            </span>
            <Skeleton className="h-3 w-16" />
          </li>
        ))}
      </ul>
    </SettingsGroup>
  );
}
