import type {
  EnvironmentId,
  McpServersFile,
  ProfileMcpServer,
  ProfileMcpValue,
  ProfilesFile,
} from "@t3tools/contracts";
import {
  mcpServerError,
  mcpServerNameError,
  profilesUsingMcpServer,
  withKey,
} from "@t3tools/client-runtime/profiles-editor";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

type Kind = "http" | "stdio";
const KIND_LABELS: Record<Kind, string> = { http: msg("URL"), stdio: msg("Command") };
const kindOf = (server: ProfileMcpServer): Kind => ("command" in server ? "stdio" : "http");
const blank = (kind: Kind): ProfileMcpServer =>
  kind === "http" ? { type: "http", url: "https://" } : { command: "" };

export function McpServersEditor(props: {
  environmentId: EnvironmentId;
  value: McpServersFile;
  profiles: ProfilesFile;
  disabled: boolean;
  onChange: (value: McpServersFile) => void;
  onDelete: (name: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const names = Object.keys(props.value.mcpServers);
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected !== null && names.includes(selected) ? selected : (names[0] ?? null);
  const server = current === null ? undefined : props.value.mcpServers[current];
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<Kind>("http");
  const newNameError = newName === "" ? null : mcpServerNameError(newName, names, m);
  const users = current === null ? [] : profilesUsingMcpServer(props.profiles, current);
  const serverError = server === undefined ? null : mcpServerError(server, m);
  const setServer = (next: ProfileMcpServer) => {
    if (current !== null)
      props.onChange({ mcpServers: { ...props.value.mcpServers, [current]: next } });
  };

  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <p className="text-xs text-muted-foreground">
        <T>
          Tick servers in a profile to add them to its Claude and Codex sessions. Other providers
          start without them. Plain values are copied to your other machines with the profiles; use
          a secret provider for tokens.
        </T>
      </p>
      {names.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={gt("MCP servers")}>
          {names.map((name) => (
            <li key={name}>
              <Button
                size="xs"
                variant={name === current ? "secondary" : "ghost"}
                aria-pressed={name === current}
                onClick={() => setSelected(name)}
              >
                {name}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={gt("New MCP server name")}
          placeholder={gt("New server name")}
          value={newName}
          disabled={props.disabled}
          aria-invalid={newNameError !== null}
          onChange={(event) => setNewName(event.target.value)}
        />
        <Select
          value={newKind}
          disabled={props.disabled}
          onValueChange={(value) => setNewKind(value === "stdio" ? "stdio" : "http")}
        >
          <SelectTrigger size="sm" aria-label={gt("New MCP server type")}>
            <SelectValue>{m(KIND_LABELS[newKind])}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="http">{m(KIND_LABELS.http)}</SelectItem>
            <SelectItem value="stdio">{m(KIND_LABELS.stdio)}</SelectItem>
          </SelectPopup>
        </Select>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || newName === "" || newNameError !== null}
          onClick={() => {
            props.onChange({
              mcpServers: { ...props.value.mcpServers, [newName]: blank(newKind) },
            });
            setSelected(newName);
            setNewName("");
          }}
        >
          <T>Add server</T>
        </Button>
      </div>
      {newNameError ? <p className="text-xs text-destructive">{newNameError}</p> : null}

      {current !== null && server !== undefined ? (
        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" size="sm">
              {m(KIND_LABELS[kindOf(server)])}
            </Badge>
            <Input
              aria-label={gt("MCP server description")}
              placeholder={gt("Description")}
              value={server.description ?? ""}
              disabled={props.disabled}
              onChange={(event) =>
                setServer(
                  withKey(
                    server,
                    "description",
                    event.target.value.trim() === "" ? undefined : event.target.value,
                  ),
                )
              }
            />
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={props.disabled}
              onClick={() => props.onDelete(current)}
            >
              <T>Delete</T>
            </Button>
          </div>
          {"command" in server ? (
            <>
              <Input
                aria-label={gt("MCP server command")}
                placeholder={gt("Command, such as {example}", { example: "npx" })}
                value={server.command}
                disabled={props.disabled}
                aria-invalid={serverError !== null}
                onChange={(event) => setServer({ ...server, command: event.target.value })}
              />
              {serverError ? <p className="text-xs text-destructive">{serverError}</p> : null}
              <Textarea
                aria-label={gt("MCP server arguments")}
                placeholder={gt("Arguments, one per line")}
                value={(server.args ?? []).join("\n")}
                disabled={props.disabled}
                onChange={(event) =>
                  setServer(
                    withKey(
                      server,
                      "args",
                      event.target.value === "" ? undefined : event.target.value.split("\n"),
                    ),
                  )
                }
              />
              <p className="text-xs text-muted-foreground">
                <T>Runs on each machine that turns on Allow MCP commands above.</T>
              </p>
              <ValuesEditor
                environmentId={props.environmentId}
                title={gt("Environment variables")}
                keyLabel={gt("Variable name")}
                values={server.env}
                disabled={props.disabled}
                onChange={(env) => setServer(withKey(server, "env", env))}
              />
            </>
          ) : (
            <>
              <Input
                aria-label={gt("MCP server URL")}
                placeholder="https://example.com/mcp"
                value={server.url}
                disabled={props.disabled}
                aria-invalid={serverError !== null}
                onChange={(event) => setServer({ ...server, url: event.target.value })}
              />
              {serverError ? <p className="text-xs text-destructive">{serverError}</p> : null}
              <ValuesEditor
                environmentId={props.environmentId}
                title={gt("Headers", { $context: "HTTP request headers" })}
                keyLabel={gt("Header name")}
                values={server.headers}
                disabled={props.disabled}
                onChange={(headers) => setServer(withKey(server, "headers", headers))}
              />
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {users.length > 0
              ? gt("Used by {profiles}.", { profiles: users.join(", ") })
              : gt("No profile uses this server.")}
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          <T>No MCP servers yet.</T>
        </p>
      )}
    </div>
  );
}

function ValuesEditor(props: {
  environmentId: EnvironmentId;
  title: string;
  keyLabel: string;
  values: Readonly<Record<string, ProfileMcpValue>> | undefined;
  disabled: boolean;
  onChange: (values: Readonly<Record<string, ProfileMcpValue>> | undefined) => void;
}) {
  const sources = useSecretSources(props.environmentId);
  const entries = Object.entries(props.values ?? {});
  const [newKey, setNewKey] = useState("");
  const set = (key: string, value: ProfileMcpValue | undefined) => {
    const next = withKey({ ...props.values }, key, value);
    props.onChange(Object.keys(next).length === 0 ? undefined : next);
  };
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-foreground">{props.title}</p>
      {entries.map(([key, value]) => (
        <div key={key} className="flex min-w-0 items-start gap-2">
          <span className="w-40 shrink-0 truncate pt-1.5 font-mono text-xs">{key}</span>
          <SecretSourceInput
            aria-label={key}
            className="min-w-0 flex-1"
            value={value}
            sources={sources}
            disabled={props.disabled}
            onChange={(event) => set(key, event.target.value)}
            onSecretChange={(secret) => set(key, secret ?? "")}
          />
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => set(key, undefined)}
          >
            <T>Remove</T>
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={props.keyLabel}
          placeholder={props.keyLabel}
          value={newKey}
          disabled={props.disabled}
          onChange={(event) => setNewKey(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={
            props.disabled ||
            newKey.trim() === "" ||
            Object.hasOwn(props.values ?? {}, newKey.trim())
          }
          onClick={() => {
            set(newKey.trim(), "");
            setNewKey("");
          }}
        >
          <T>Add</T>
        </Button>
      </div>
    </div>
  );
}
