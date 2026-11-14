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
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

type Kind = "http" | "stdio";
const KIND_LABELS: Record<Kind, string> = { http: "URL", stdio: "Command" };
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
  const names = Object.keys(props.value.mcpServers);
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected !== null && names.includes(selected) ? selected : (names[0] ?? null);
  const server = current === null ? undefined : props.value.mcpServers[current];
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<Kind>("http");
  const newNameError = newName === "" ? null : mcpServerNameError(newName, names);
  const users = current === null ? [] : profilesUsingMcpServer(props.profiles, current);
  const serverError = server === undefined ? null : mcpServerError(server);
  const setServer = (next: ProfileMcpServer) => {
    if (current !== null)
      props.onChange({ mcpServers: { ...props.value.mcpServers, [current]: next } });
  };

  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <p className="text-xs text-muted-foreground">
        Tick servers in a profile to add them to its Claude and Codex sessions. Other providers
        start without them. Plain values are copied to your other machines with the profiles; use a
        secret provider for tokens.
      </p>
      {names.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="MCP servers">
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
          aria-label="New MCP server name"
          placeholder="New server name"
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
          <SelectTrigger size="sm" aria-label="New MCP server type">
            <SelectValue>{KIND_LABELS[newKind]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="http">{KIND_LABELS.http}</SelectItem>
            <SelectItem value="stdio">{KIND_LABELS.stdio}</SelectItem>
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
          Add server
        </Button>
      </div>
      {newNameError ? <p className="text-xs text-destructive">{newNameError}</p> : null}

      {current !== null && server !== undefined ? (
        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" size="sm">
              {KIND_LABELS[kindOf(server)]}
            </Badge>
            <Input
              aria-label="MCP server description"
              placeholder="Description"
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
              Delete
            </Button>
          </div>
          {"command" in server ? (
            <>
              <Input
                aria-label="MCP server command"
                placeholder="Command, such as npx"
                value={server.command}
                disabled={props.disabled}
                aria-invalid={serverError !== null}
                onChange={(event) => setServer({ ...server, command: event.target.value })}
              />
              {serverError ? <p className="text-xs text-destructive">{serverError}</p> : null}
              <Textarea
                aria-label="MCP server arguments"
                placeholder="Arguments, one per line"
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
                Runs on each machine that turns on Allow MCP commands above.
              </p>
              <ValuesEditor
                environmentId={props.environmentId}
                title="Environment variables"
                keyLabel="Variable name"
                values={server.env}
                disabled={props.disabled}
                onChange={(env) => setServer(withKey(server, "env", env))}
              />
            </>
          ) : (
            <>
              <Input
                aria-label="MCP server URL"
                placeholder="https://example.com/mcp"
                value={server.url}
                disabled={props.disabled}
                aria-invalid={serverError !== null}
                onChange={(event) => setServer({ ...server, url: event.target.value })}
              />
              {serverError ? <p className="text-xs text-destructive">{serverError}</p> : null}
              <ValuesEditor
                environmentId={props.environmentId}
                title="Headers"
                keyLabel="Header name"
                values={server.headers}
                disabled={props.disabled}
                onChange={(headers) => setServer(withKey(server, "headers", headers))}
              />
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {users.length > 0 ? `Used by ${users.join(", ")}.` : "No profile uses this server."}
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No MCP servers yet.</p>
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
            Remove
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
          Add
        </Button>
      </div>
    </div>
  );
}
