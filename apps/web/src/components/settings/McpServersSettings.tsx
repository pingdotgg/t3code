/**
 * Settings panel for user-configured MCP servers. Each enabled server here
 * gets merged into every underlying agent CLI's session (Claude/Codex/Grok/
 * Cursor/OpenCode) alongside T3's own built-in MCP server — see
 * `apps/server/src/mcp/resolveSessionMcpServers.ts`.
 */
import type { McpServerConfig, McpServerId } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  Loader2Icon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { mcpServersEnvironment } from "../../state/mcpServers";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type TransportKind = "stdio" | "http" | "sse";

interface KeyValueRow {
  readonly rowId: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted: boolean;
}

interface McpServerDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly transportType: TransportKind;
  readonly command: string;
  readonly argsText: string;
  readonly cwd: string;
  readonly env: ReadonlyArray<KeyValueRow>;
  readonly url: string;
  readonly headers: ReadonlyArray<KeyValueRow>;
}

function makeRowId(): string {
  return Math.random().toString(36).slice(2);
}

const EMPTY_DRAFT: McpServerDraft = {
  name: "",
  enabled: true,
  transportType: "stdio",
  command: "",
  argsText: "",
  cwd: "",
  env: [],
  url: "",
  headers: [],
};

function draftFromConfig(config: McpServerConfig): McpServerDraft {
  const transport = config.transport;
  if (transport.type === "stdio") {
    return {
      name: config.name,
      enabled: config.enabled,
      transportType: "stdio",
      command: transport.command,
      argsText: transport.args.join(" "),
      cwd: transport.cwd ?? "",
      env: (transport.env ?? []).map((variable) => ({
        rowId: makeRowId(),
        name: variable.name,
        value: variable.value,
        sensitive: variable.sensitive,
        valueRedacted: variable.valueRedacted ?? false,
      })),
      url: "",
      headers: [],
    };
  }
  return {
    name: config.name,
    enabled: config.enabled,
    transportType: transport.type,
    command: "",
    argsText: "",
    cwd: "",
    env: [],
    url: transport.url,
    headers: (transport.headers ?? []).map((header) => ({
      rowId: makeRowId(),
      name: header.name,
      value: header.value,
      sensitive: header.sensitive,
      valueRedacted: header.valueRedacted ?? false,
    })),
  };
}

function configFromDraft(draft: McpServerDraft): McpServerConfig {
  const toFields = (rows: ReadonlyArray<KeyValueRow>) =>
    rows
      .filter((row) => row.name.trim().length > 0)
      .map((row) => ({
        name: row.name.trim(),
        value: row.value,
        sensitive: row.sensitive,
        ...(row.valueRedacted ? { valueRedacted: true } : {}),
      }));

  if (draft.transportType === "stdio") {
    return {
      name: draft.name.trim(),
      enabled: draft.enabled,
      transport: {
        type: "stdio",
        command: draft.command.trim(),
        args: draft.argsText.trim().length > 0 ? draft.argsText.trim().split(/\s+/) : [],
        ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
        ...(draft.env.length > 0 ? { env: toFields(draft.env) } : {}),
      },
    };
  }
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: {
      type: draft.transportType,
      url: draft.url.trim(),
      ...(draft.headers.length > 0 ? { headers: toFields(draft.headers) } : {}),
    },
  };
}

function isDraftValid(draft: McpServerDraft): boolean {
  if (draft.name.trim().length === 0) return false;
  return draft.transportType === "stdio"
    ? draft.command.trim().length > 0
    : draft.url.trim().length > 0;
}

function transportSummary(config: McpServerConfig): string {
  return config.transport.type === "stdio"
    ? [config.transport.command, ...config.transport.args].join(" ")
    : config.transport.url;
}

function KeyValueRowsEditor({
  title,
  addLabel,
  rows,
  onChange,
}: {
  readonly title: string;
  readonly addLabel: string;
  readonly rows: ReadonlyArray<KeyValueRow>;
  readonly onChange: (rows: ReadonlyArray<KeyValueRow>) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-xs"
          onClick={() =>
            onChange([
              ...rows,
              { rowId: makeRowId(), name: "", value: "", sensitive: false, valueRedacted: false },
            ])
          }
        >
          <PlusIcon className="size-3" />
          {addLabel}
        </Button>
      </div>
      {rows.map((row) => (
        <div key={row.rowId} className="flex items-center gap-2">
          <Input
            size="sm"
            placeholder="Name"
            value={row.name}
            onChange={(event) =>
              onChange(
                rows.map((r) => (r.rowId === row.rowId ? { ...r, name: event.target.value } : r)),
              )
            }
            className="w-40"
          />
          <Input
            size="sm"
            type={row.sensitive ? "password" : "text"}
            placeholder={row.valueRedacted ? "(unchanged)" : "Value"}
            value={row.value}
            onChange={(event) =>
              onChange(
                rows.map((r) =>
                  r.rowId === row.rowId
                    ? { ...r, value: event.target.value, valueRedacted: false }
                    : r,
                ),
              )
            }
            className="flex-1"
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={row.sensitive}
              onCheckedChange={(checked) =>
                onChange(
                  rows.map((r) =>
                    r.rowId === row.rowId ? { ...r, sensitive: checked === true } : r,
                  ),
                )
              }
            />
            Secret
          </label>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Remove"
            onClick={() => onChange(rows.filter((r) => r.rowId !== row.rowId))}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function AddMcpServerDialog({
  open,
  onOpenChange,
  initialDraft,
  onSave,
  onTestConnection,
  isSaving,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialDraft: McpServerDraft;
  readonly onSave: (config: McpServerConfig) => void;
  readonly onTestConnection: (
    config: McpServerConfig,
  ) => Promise<{ status: "ok" | "error"; toolNames: ReadonlyArray<string>; detail?: string }>;
  readonly isSaving: boolean;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [testState, setTestState] = useState<
    | { status: "idle" }
    | { status: "pending" }
    | { status: "ok"; toolNames: ReadonlyArray<string> }
    | { status: "error"; detail?: string }
  >({ status: "idle" });

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraft(initialDraft);
      setTestState({ status: "idle" });
    }
    onOpenChange(next);
  };

  const handleTest = async () => {
    setTestState({ status: "pending" });
    const result = await onTestConnection(configFromDraft(draft));
    setTestState(
      result.status === "ok"
        ? { status: "ok", toolNames: result.toolNames }
        : { status: "error", ...(result.detail ? { detail: result.detail } : {}) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>MCP server</DialogTitle>
          <DialogDescription>
            Connect once here and it becomes available to whichever agent is driving a thread —
            Claude, Codex, Grok, Cursor, or OpenCode.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[60vh] space-y-4 overflow-y-auto">
          <div className="flex items-center gap-3">
            <Input
              placeholder="Name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="flex-1"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={draft.enabled}
                onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
              />
              Enabled
            </label>
          </div>

          <div className="flex gap-1.5">
            {(["stdio", "http", "sse"] as const).map((kind) => (
              <Button
                key={kind}
                type="button"
                size="sm"
                variant={draft.transportType === kind ? "default" : "outline"}
                className="h-7 px-3 text-xs"
                onClick={() => setDraft({ ...draft, transportType: kind })}
              >
                {kind === "stdio" ? "Command" : kind.toUpperCase()}
              </Button>
            ))}
          </div>

          {draft.transportType === "stdio" ? (
            <div className="space-y-3">
              <Input
                placeholder="Command (e.g. npx)"
                value={draft.command}
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              />
              <Input
                placeholder="Arguments (space-separated)"
                value={draft.argsText}
                onChange={(event) => setDraft({ ...draft, argsText: event.target.value })}
              />
              <Input
                placeholder="Working directory (optional)"
                value={draft.cwd}
                onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
              />
              <KeyValueRowsEditor
                title="Environment variables"
                addLabel="Add variable"
                rows={draft.env}
                onChange={(env) => setDraft({ ...draft, env })}
              />
            </div>
          ) : (
            <div className="space-y-3">
              <Input
                placeholder="https://example.com/mcp"
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
              <KeyValueRowsEditor
                title="Headers"
                addLabel="Add header"
                rows={draft.headers}
                onChange={(headers) => setDraft({ ...draft, headers })}
              />
            </div>
          )}

          <div className="rounded-md border border-border/70 bg-muted/20 p-3 text-xs">
            {testState.status === "idle" ? (
              <span className="text-muted-foreground">
                Test the connection to confirm the server responds and list its tools.
              </span>
            ) : testState.status === "pending" ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" /> Connecting…
              </span>
            ) : testState.status === "ok" ? (
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-foreground">
                  <CheckCircle2Icon className="size-3.5 text-green-600" /> Connected —{" "}
                  {testState.toolNames.length} tool{testState.toolNames.length === 1 ? "" : "s"}{" "}
                  found
                </span>
                {testState.toolNames.length > 0 ? (
                  <span className="text-muted-foreground">{testState.toolNames.join(", ")}</span>
                ) : null}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-destructive-foreground">
                <XCircleIcon className="size-3.5" />
                {testState.detail ?? "Failed to connect."}
              </span>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleTest}
            disabled={!isDraftValid(draft) || testState.status === "pending"}
          >
            Test connection
          </Button>
          <Button
            type="button"
            onClick={() => onSave(configFromDraft(draft))}
            disabled={!isDraftValid(draft) || isSaving}
          >
            {isSaving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function McpServersSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const list = useEnvironmentQuery(
    environmentId === null ? null : mcpServersEnvironment.list({ environmentId, input: {} }),
  );
  const servers = list.data?.servers ?? [];

  const upsert = useAtomCommand(mcpServersEnvironment.upsert);
  const remove = useAtomCommand(mcpServersEnvironment.remove);
  const testConnection = useAtomCommand(mcpServersEnvironment.testConnection);

  const [dialogState, setDialogState] = useState<
    { open: false } | { open: true; id: McpServerId | null; draft: McpServerDraft }
  >({ open: false });
  const [isSaving, setIsSaving] = useState(false);

  if (environmentId === null) return null;

  const handleSave = async (config: McpServerConfig) => {
    if (!dialogState.open) return;
    setIsSaving(true);
    const result = await upsert({
      environmentId,
      input: { ...(dialogState.id ? { id: dialogState.id } : {}), config },
    });
    setIsSaving(false);
    if (result._tag === "Success") {
      setDialogState({ open: false });
      list.refresh();
    }
  };

  const handleTestConnection = async (
    config: McpServerConfig,
  ): Promise<{ status: "ok" | "error"; toolNames: ReadonlyArray<string>; detail?: string }> => {
    const result = await testConnection({ environmentId, input: { config } });
    if (result._tag !== "Success") {
      return { status: "error", toolNames: [], detail: "Failed to connect." };
    }
    return {
      status: result.value.status,
      toolNames: result.value.toolNames,
      ...(result.value.detail ? { detail: result.value.detail } : {}),
    };
  };

  const handleRemove = async (id: McpServerId) => {
    const result = await remove({ environmentId, input: { id } });
    if (result._tag === "Success") list.refresh();
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("mcp-servers")}
        title="MCP Servers"
        icon={<PlugIcon className="size-4.5 text-muted-foreground" />}
        headerAction={
          <Button
            size="sm"
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={() => setDialogState({ open: true, id: null, draft: EMPTY_DRAFT })}
          >
            <PlusIcon className="size-3.5" />
            Add MCP Server
          </Button>
        }
      >
        <div className="space-y-2 px-3 sm:px-4">
          {servers.length === 0 ? (
            <Empty className="rounded-lg border border-dashed border-border/70 p-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PlugIcon />
                </EmptyMedia>
                <EmptyTitle>No MCP servers yet</EmptyTitle>
                <EmptyDescription>
                  Connect an MCP server once and it becomes available to every agent CLI.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialogState({ open: true, id: null, draft: EMPTY_DRAFT })}
                >
                  Add MCP Server
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            servers.map(({ id, config }) => (
              <div
                key={id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {config.name}
                    </span>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {config.transport.type}
                    </Badge>
                    {!config.enabled ? (
                      <Badge variant="secondary" className="text-[10px]">
                        Disabled
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {transportSummary(config)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    checked={config.enabled}
                    onCheckedChange={(checked) =>
                      void upsert({
                        environmentId,
                        input: { id, config: { ...config, enabled: checked } },
                      }).then((result) => {
                        if (result._tag === "Success") list.refresh();
                      })
                    }
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Edit"
                    onClick={() =>
                      setDialogState({ open: true, id, draft: draftFromConfig(config) })
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Remove"
                    onClick={() => void handleRemove(id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsSection>

      {dialogState.open ? (
        <AddMcpServerDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialogState({ open: false });
          }}
          initialDraft={dialogState.draft}
          onSave={(config) => void handleSave(config)}
          onTestConnection={handleTestConnection}
          isSaving={isSaving}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
