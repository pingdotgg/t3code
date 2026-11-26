// Fork: Kaluwa's Extensions page. Add an MCP server, a plugin or a library skill.
import type {
  ExtensionKind,
  ExtensionMcpTransport,
  ExtensionsMutation,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { GlobeIcon, LockIcon, PlusIcon, TerminalIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CheckboxMark } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { type ExtensionsAddPreset, useExtensions } from "./extensionsContext";
import { type ParsedMcpServer, parseMcpJson, splitCommandLine } from "./extensionsMcpJson";
import { EXTENSION_KINDS, supportsKind } from "./extensionsModel";
import { EditButton, SubscriptionIcon, useKindLabels } from "./extensionsParts";

const COMMAND_EXAMPLE = "npx -y @modelcontextprotocol/server-github";
const JSON_EXAMPLE = `{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "server-github"] }
  }
}`;
const SECRET_NAME_EXAMPLE = { stdio: "API_KEY", http: "Authorization", sse: "Authorization" };

const TRANSPORTS = ["stdio", "http", "sse"] as const satisfies readonly ExtensionMcpTransport[];

interface SecretRow {
  readonly id: number;
  readonly name: string;
  readonly value: string;
}

function formServer(
  name: string,
  transport: ExtensionMcpTransport,
  target: string,
  secrets: readonly SecretRow[],
): ParsedMcpServer | null {
  const record = Object.fromEntries(
    secrets
      .filter((row) => row.name.trim() !== "")
      .map((row) => [row.name.trim(), row.value] as const),
  );
  if (name.trim() === "" || target.trim() === "") return null;
  if (transport === "stdio") {
    const [command, ...args] = splitCommandLine(target);
    if (command === undefined) return null;
    return {
      name: name.trim(),
      spec: { _tag: "stdio", command, args, env: record },
      secretNames: Object.keys(record),
    };
  }
  return {
    name: name.trim(),
    spec: { _tag: "remote", transport, url: target.trim(), headers: record },
    secretNames: Object.keys(record),
  };
}

function ServerPreview({ server }: { readonly server: ParsedMcpServer }) {
  const gt = useGT();
  const Icon = server.spec._tag === "stdio" ? TerminalIcon : GlobeIcon;
  return (
    <li className="flex items-center gap-2.5 px-3 py-2">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">{server.name}</span>
          <Badge variant="outline" size="sm">
            {server.spec._tag === "stdio" ? "stdio" : server.spec.transport}
          </Badge>
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {server.spec._tag === "stdio"
            ? [server.spec.command, ...server.spec.args].join(" ")
            : server.spec.url}
        </span>
      </span>
      {server.secretNames.length > 0 ? (
        <Badge variant="warning">
          <LockIcon />
          {gt("{count, plural, one {{count} secret} other {{count} secrets}}", {
            count: server.secretNames.length,
          })}
        </Badge>
      ) : (
        <Badge variant="success">
          <T>Ready</T>
        </Badge>
      )}
    </li>
  );
}

export function ExtensionsAddDialog({
  preset,
  onClose,
}: {
  readonly preset: ExtensionsAddPreset;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const kinds = useKindLabels();
  const fieldId = useId();
  const { list, entries, run } = useExtensions();
  const subscriptions = list.subscriptions;
  const supported = (kind: ExtensionKind) =>
    subscriptions.filter((subscription) => supportsKind(subscription, kind));
  const presetSubscription = subscriptions.find(
    (subscription) => subscription.instanceId === preset.instanceId,
  );

  const [kind, setKind] = useState<ExtensionKind>(
    () =>
      preset.kind ??
      EXTENSION_KINDS.find((candidate) =>
        presetSubscription
          ? supportsKind(presetSubscription, candidate)
          : supported(candidate).length > 0,
      ) ??
      "mcp",
  );
  const [targets, setTargets] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(preset.instanceId ? [preset.instanceId] : []),
  );
  const [mode, setMode] = useState<"form" | "json">("form");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<ExtensionMcpTransport>("stdio");
  const [target, setTarget] = useState("");
  const [secrets, setSecrets] = useState<readonly SecretRow[]>([]);
  const [json, setJson] = useState("");
  const [pluginId, setPluginId] = useState("");
  const [skills, setSkills] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const available = supported(kind);
  const chosen = available.filter((subscription) => targets.has(subscription.instanceId));
  const instanceIds = chosen.map((subscription) => subscription.instanceId);
  const parsed = parseMcpJson(json);
  const servers =
    mode === "json"
      ? parsed.servers
      : [formServer(name, transport, target, secrets)].flatMap((server) =>
          server ? [server] : [],
        );
  const plugin = pluginId.trim();
  const pluginValid = /^[^@\s]+@[^@\s]+$/.test(plugin);
  const librarySkills = entries.filter((entry) => entry.kind === "skill" && entry.inLibrary);
  const knownPlugins = entries.filter((entry) => entry.kind === "plugin");

  const mutations: readonly ExtensionsMutation[] =
    instanceIds.length === 0
      ? []
      : kind === "mcp"
        ? servers.map((server) => ({
            _tag: "McpAdd",
            instanceIds,
            name: server.name,
            spec: server.spec,
          }))
        : kind === "plugin"
          ? pluginValid
            ? [{ _tag: "PluginInstall", instanceIds, pluginId: plugin }]
            : []
          : [...skills].map((skill) => ({ _tag: "SkillLink", instanceIds, name: skill }));

  const submit = async () => {
    setSaving(true);
    const ok = await run(mutations);
    setSaving(false);
    if (ok) onClose();
  };
  const toggleTarget = (instanceId: ProviderInstanceId) =>
    setTargets((current) => {
      const next = new Set(current);
      if (next.has(instanceId)) next.delete(instanceId);
      else next.add(instanceId);
      return next;
    });
  const subject =
    kind === "mcp"
      ? gt("{count, plural, one {{count} server} other {{count} servers}}", {
          count: servers.length,
        })
      : kind === "plugin"
        ? plugin
        : gt("{count, plural, one {{count} skill} other {{count} skills}}", {
            count: skills.size,
          });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>Add an extension</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <ToggleGroup
            aria-label={gt("Kind of extension")}
            variant="segmented"
            value={[kind]}
            onValueChange={(next) => {
              const value = EXTENSION_KINDS.find((candidate) => candidate === next[0]);
              if (value) setKind(value);
            }}
          >
            {EXTENSION_KINDS.map((value) => (
              <Toggle key={value} value={value} disabled={supported(value).length === 0}>
                {kinds.singular(value)}
              </Toggle>
            ))}
          </ToggleGroup>

          {kind === "mcp" ? (
            <div className="flex flex-col gap-3">
              <ToggleGroup
                aria-label={gt("How to enter the server")}
                variant="segmented"
                value={[mode]}
                onValueChange={(next) => {
                  if (next[0] === "form" || next[0] === "json") setMode(next[0]);
                }}
              >
                <Toggle value="form">
                  <T>Fill in a form</T>
                </Toggle>
                <Toggle value="json">
                  <T>Paste JSON from docs</T>
                </Toggle>
              </ToggleGroup>
              {mode === "form" ? (
                <>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                      <Label htmlFor={`${fieldId}-name`}>
                        <T>Name</T>
                      </Label>
                      <Input
                        id={`${fieldId}-name`}
                        value={name}
                        placeholder="github"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                    <ToggleGroup
                      aria-label={gt("Transport")}
                      variant="segmented"
                      value={[transport]}
                      onValueChange={(next) => {
                        const value = TRANSPORTS.find((candidate) => candidate === next[0]);
                        if (value) setTransport(value);
                      }}
                    >
                      {TRANSPORTS.map((value) => (
                        <Toggle key={value} value={value}>
                          {value}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${fieldId}-target`}>
                      {transport === "stdio" ? gt("Command") : gt("URL")}
                    </Label>
                    <Input
                      id={`${fieldId}-target`}
                      value={target}
                      placeholder={
                        transport === "stdio" ? COMMAND_EXAMPLE : "https://mcp.example.com/mcp"
                      }
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setTarget(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">
                      {transport === "stdio" ? gt("Environment variables") : gt("Headers")}
                    </span>
                    {secrets.map((row) => (
                      <div key={row.id} className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <Input
                            size="sm"
                            value={row.name}
                            aria-label={gt("Name")}
                            placeholder={SECRET_NAME_EXAMPLE[transport]}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) =>
                              setSecrets((current) =>
                                current.map((entry) =>
                                  entry.id === row.id
                                    ? { ...entry, name: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <Input
                            size="sm"
                            type="password"
                            value={row.value}
                            aria-label={gt("Value of {name}", { name: row.name })}
                            placeholder={gt("Value")}
                            autoComplete="off"
                            onChange={(event) =>
                              setSecrets((current) =>
                                current.map((entry) =>
                                  entry.id === row.id
                                    ? { ...entry, value: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                          />
                        </div>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={gt("Remove {name}", { name: row.name })}
                          onClick={() =>
                            setSecrets((current) => current.filter((entry) => entry.id !== row.id))
                          }
                        >
                          <XIcon />
                        </Button>
                      </div>
                    ))}
                    <span>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          setSecrets((current) => [
                            ...current,
                            { id: (current.at(-1)?.id ?? 0) + 1, name: "", value: "" },
                          ])
                        }
                      >
                        <PlusIcon />
                        {transport === "stdio" ? gt("Add a variable") : gt("Add a header")}
                      </Button>
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <Textarea
                    value={json}
                    rows={8}
                    aria-label={gt("MCP server JSON")}
                    placeholder={JSON_EXAMPLE}
                    spellCheck={false}
                    onChange={(event) => setJson(event.target.value)}
                  />
                  {parsed.problem !== null ? (
                    <p className="text-xs text-destructive-foreground">
                      {parsed.problem === "syntax"
                        ? gt("This isn't valid JSON yet.")
                        : parsed.problem === "unnamed"
                          ? gt("Give the server a name: wrap it as {example}.", {
                              example: '{ "name": { … } }',
                            })
                          : gt("No server with a command or a URL was found.")}
                    </p>
                  ) : null}
                  {parsed.servers.length > 0 ? (
                    <ul className="divide-y rounded-lg border">
                      {parsed.servers.map((server) => (
                        <ServerPreview key={server.name} server={server} />
                      ))}
                    </ul>
                  ) : null}
                  {parsed.servers.length > 0 && parsed.skipped.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {gt("Skipped, no command or URL: {names}", {
                        names: parsed.skipped.join(", "),
                      })}
                    </p>
                  ) : null}
                </>
              )}
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <LockIcon aria-hidden className="size-3 shrink-0" />
                <T>Secret values are stored on save and hidden from then on.</T>
              </p>
            </div>
          ) : kind === "plugin" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-plugin`}>
                <T>Plugin</T>
              </Label>
              <Input
                id={`${fieldId}-plugin`}
                value={pluginId}
                placeholder="name@marketplace"
                autoComplete="off"
                spellCheck={false}
                list={`${fieldId}-plugins`}
                onChange={(event) => setPluginId(event.target.value)}
              />
              <datalist id={`${fieldId}-plugins`}>
                {knownPlugins.map((entry) => (
                  <option key={entry.key} value={entry.id} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">
                <T>
                  The plugin's name, an @, then the marketplace it comes from. The marketplace has
                  to be added to the subscription already.
                </T>
              </p>
            </div>
          ) : librarySkills.length === 0 ? (
            <p className="rounded-lg border px-3 py-4 text-center text-sm text-muted-foreground">
              <T>
                The skill library is empty. Move a skill into it from the Skill library page first.
              </T>
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {librarySkills.map((entry) => {
                const checked = skills.has(entry.id);
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-start outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() =>
                        setSkills((current) => {
                          const next = new Set(current);
                          if (checked) next.delete(entry.id);
                          else next.add(entry.id);
                          return next;
                        })
                      }
                    >
                      <CheckboxMark checked={checked} />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">{entry.name}</span>
                        {entry.description ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {entry.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-col gap-2">
            <span className="flex items-baseline gap-2 text-sm font-medium">
              <T>Add to</T>
              <span className="text-xs font-normal text-muted-foreground">
                <T>choose one or more</T>
              </span>
            </span>
            <div className="flex flex-wrap gap-2">
              {subscriptions.map((subscription) => {
                const usable = supportsKind(subscription, kind);
                const pressed = usable && targets.has(subscription.instanceId);
                return (
                  <button
                    key={subscription.instanceId}
                    type="button"
                    aria-pressed={pressed}
                    disabled={!usable}
                    className={cn(
                      "flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                      pressed && "border-primary bg-primary/8",
                    )}
                    onClick={() => toggleTarget(subscription.instanceId)}
                  >
                    <SubscriptionIcon subscription={subscription} size="compact" />
                    <span className="max-w-40 truncate">{subscription.displayName}</span>
                  </button>
                );
              })}
            </div>
            {available.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>None of your subscriptions use these.</T>
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <span className="min-w-0 flex-1 self-center text-xs text-muted-foreground">
            {mutations.length > 0
              ? gt("Adds {subject} to {subscriptions}. User-level.", {
                  subject,
                  subscriptions: chosen.map((subscription) => subscription.displayName).join(", "),
                })
              : chosen.length === 0
                ? gt("Choose a subscription to add to.")
                : gt("Fill in what to add.")}
          </span>
          <Button variant="ghost" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <EditButton
            busy={saving}
            busyLabel={gt("Adding…")}
            disabled={mutations.length === 0}
            onClick={() => void submit()}
          >
            <T>Add</T>
          </EditButton>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
