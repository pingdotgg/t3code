import { ChevronRightIcon, CopyIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import type { McpServerInventory, McpServerInventoryEntry } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import {
  fetchEnvironmentMcpInventory,
  setEnvironmentMcpServerEnabled,
} from "@t3tools/client-runtime/state/mcp";
import { cn } from "../../lib/utils";
import { runtime } from "../../lib/runtime";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  filterMcpInventory,
  formatMcpConfigPath,
  groupMcpServersByHarness,
  mcpServerKey,
  withServerEnabled,
} from "./McpServersSettings.logic";

type InventoryState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly inventory: McpServerInventory }
  | { readonly status: "error"; readonly message: string };

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "Could not load MCP servers.";
}

function connectionDotClassName(phase: string): string {
  if (phase === "connected") return "bg-success";
  if (phase === "connecting" || phase === "reconnecting") return "bg-warning";
  if (phase === "error") return "bg-destructive";
  return "bg-muted-foreground/40";
}

function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
        open && "rotate-90",
        className,
      )}
    />
  );
}

function StatusLine({ children, tone }: { children: string; tone?: "error" }) {
  return (
    <p
      className={cn(
        "py-2 pr-3 pl-9 text-[13px] sm:pr-4",
        tone === "error" ? "text-destructive" : "text-muted-foreground/80",
      )}
    >
      {children}
    </p>
  );
}

export function McpServersSettings() {
  const { environments } = useEnvironments();
  const [query, setQuery] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="MCP"
        icon={<PlugIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button size="xs" variant="ghost" onClick={() => setRefreshKey((value) => value + 1)}>
            <RefreshCwIcon className="size-3.5" />
            Refresh all
          </Button>
        }
      >
        <div className="space-y-2.5 px-3 pb-3 sm:px-4">
          <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
            MCP servers each harness loads on every connected computer. Turning one off keeps its
            tools out of new sessions without editing config files by hand.
          </p>
          <Input
            type="search"
            nativeInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search servers, harnesses, or paths"
            aria-label="Search MCP servers"
            className="max-w-sm"
          />
        </div>

        <div className="divide-y divide-border/50 border-t border-border/50">
          {environments.map((environment) => (
            <EnvironmentMcpInventory
              key={environment.environmentId}
              environment={environment}
              query={query}
              refreshKey={refreshKey}
            />
          ))}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentMcpInventory({
  environment,
  query,
  refreshKey,
}: {
  environment: EnvironmentPresentation;
  query: string;
  refreshKey: number;
}) {
  const prepared = usePreparedConnection(environment.environmentId);
  const [state, setState] = useState<InventoryState>({ status: "loading" });
  const [collapsed, setCollapsed] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const panelId = useId();

  useEffect(() => {
    if (Option.isNone(prepared)) return;
    let cancelled = false;
    setState({ status: "loading" });
    void runtime
      .runPromise(fetchEnvironmentMcpInventory({ prepared: prepared.value }))
      .then((inventory) => {
        if (!cancelled) setState({ status: "loaded", inventory });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [prepared, refreshKey]);

  const toggleServer = useCallback(
    (server: McpServerInventoryEntry, enabled: boolean) => {
      if (Option.isNone(prepared)) return;
      const key = mcpServerKey(server);
      setPendingKeys((keys) => new Set(keys).add(key));
      // Optimistic: the switch answers immediately, and the server's fresh
      // inventory replaces this state either way.
      setState((current) =>
        current.status === "loaded"
          ? {
              status: "loaded",
              inventory: withServerEnabled(
                current.inventory,
                { providerInstanceId: server.providerInstanceId, name: server.name },
                enabled,
              ),
            }
          : current,
      );
      void runtime
        .runPromise(
          setEnvironmentMcpServerEnabled({
            prepared: prepared.value,
            patch: {
              providerInstanceId: server.providerInstanceId,
              name: server.name,
              enabled,
            },
          }),
        )
        .then((inventory) => {
          setState({ status: "loaded", inventory });
        })
        .catch((cause: unknown) => {
          toastManager.add({
            type: "error",
            title: enabled ? "Could not enable server" : "Could not disable server",
            description: errorMessage(cause),
          });
          setState((current) =>
            current.status === "loaded"
              ? {
                  status: "loaded",
                  inventory: withServerEnabled(
                    current.inventory,
                    { providerInstanceId: server.providerInstanceId, name: server.name },
                    !enabled,
                  ),
                }
              : current,
          );
        })
        .finally(() => {
          setPendingKeys((keys) => {
            const next = new Set(keys);
            next.delete(key);
            return next;
          });
        });
    },
    [prepared],
  );

  const groups = useMemo(() => {
    if (state.status !== "loaded") return [];
    return groupMcpServersByHarness(filterMcpInventory(state.inventory, query).servers);
  }, [state, query]);

  const serverCount = state.status === "loaded" ? state.inventory.servers.length : null;

  return (
    <div>
      <button
        type="button"
        aria-controls={panelId}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 sm:px-4"
        onClick={() => setCollapsed((value) => !value)}
      >
        <DisclosureChevron open={!collapsed} />
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            connectionDotClassName(environment.connection.phase),
          )}
        />
        <span className="truncate font-medium text-[13px]">{environment.label}</span>
        {serverCount !== null ? (
          <span className="ml-auto shrink-0 text-muted-foreground/70 text-xs">
            {serverCount} {serverCount === 1 ? "server" : "servers"}
          </span>
        ) : null}
      </button>

      {collapsed ? null : (
        <div id={panelId}>
          {Option.isNone(prepared) ? (
            <StatusLine>Not connected.</StatusLine>
          ) : state.status === "loading" ? (
            <StatusLine>Loading MCP servers…</StatusLine>
          ) : state.status === "error" ? (
            <StatusLine tone="error">{state.message}</StatusLine>
          ) : groups.length === 0 ? (
            <StatusLine>
              {query.trim()
                ? "No MCP servers match this search."
                : "No MCP servers configured for Claude or Codex on this computer."}
            </StatusLine>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="pb-1">
                <p className="px-3 pt-2 pb-1 pl-9 font-medium text-muted-foreground/70 text-xs sm:px-4 sm:pl-9">
                  {group.harnessDisplayName}
                </p>
                {group.servers.map((server) => (
                  <McpServerRow
                    key={mcpServerKey(server)}
                    server={server}
                    pending={pendingKeys.has(mcpServerKey(server))}
                    onToggle={toggleServer}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function McpServerRow({
  server,
  pending,
  onToggle,
}: {
  server: McpServerInventoryEntry;
  pending: boolean;
  onToggle: (server: McpServerInventoryEntry, enabled: boolean) => void;
}) {
  const { copyToClipboard } = useCopyToClipboard<{ value: string }>({
    target: "path",
    onCopy: ({ value }) => {
      toastManager.add({ type: "success", title: "Path copied", description: value });
    },
  });

  return (
    <div className="flex items-center gap-3 px-3 py-2 pl-9 sm:px-4 sm:pl-9">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-[13px]">{server.name}</span>
          <span className="shrink-0 rounded border border-border/60 px-1 text-[10px] text-muted-foreground/80 uppercase">
            {server.transport}
          </span>
          {server.status ? (
            <span className="shrink-0 text-muted-foreground/70 text-xs">{server.status}</span>
          ) : null}
        </div>
        {server.detail ? (
          <p className="truncate text-muted-foreground/70 text-xs" title={server.detail}>
            {server.detail}
          </p>
        ) : null}
      </div>

      {server.configPath ? (
        <button
          type="button"
          className="shrink-0 text-muted-foreground/70 text-xs hover:text-foreground"
          title={server.configPath}
          onClick={() =>
            copyToClipboard(server.configPath ?? "", { value: server.configPath ?? "" })
          }
        >
          <span className="inline-flex items-center gap-1">
            <CopyIcon className="size-3" aria-hidden />
            {formatMcpConfigPath(server.configPath)}
          </span>
        </button>
      ) : null}

      <Switch
        checked={server.enabled}
        disabled={!server.toggleable || pending}
        aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
        onCheckedChange={(checked) => onToggle(server, checked)}
      />
    </div>
  );
}
