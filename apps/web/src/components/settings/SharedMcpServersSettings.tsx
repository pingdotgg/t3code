import { type SharedMcpServer, SharedMcpServerTestError } from "@t3tools/contracts";
import {
  parseSharedMcpServerDraft,
  sharedMcpServerDraft,
  type SharedMcpServerDraft,
  upsertSharedMcpServer,
} from "@t3tools/client-runtime/state/shared-mcp-servers";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  LogInIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { type Dispatch, type SetStateAction, useState } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { type EnvironmentPresentation, useEnvironmentHttpBaseUrl } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const isTestError = Schema.is(SharedMcpServerTestError);

type FormState = {
  readonly environmentId: EnvironmentPresentation["environmentId"];
  readonly editing?: SharedMcpServer;
} | null;

/** MCP servers added once here reach every agent session on the selected environment. */
export function SharedMcpServersSettings() {
  const scope = useSettingsScope();
  // "All environments" with a single connected one still has an obvious target.
  const environment =
    scope.environment ??
    (scope.connectedEnvironments.length === 1 ? scope.connectedEnvironments[0] : undefined);
  const { environments } = scope;
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const [openForm, setForm] = useState<FormState>(null);
  // A form opened for another environment doesn't follow a scope change.
  const form = openForm?.environmentId === environment?.environmentId ? openForm : null;

  return (
    <SettingsSection
      {...searchableSetting("shared-mcp-servers")}
      headerAction={
        connected ? (
          <Button
            size="xs"
            variant="outline"
            disabled={form !== null}
            onClick={() => environment && setForm({ environmentId: environment.environmentId })}
          >
            <PlusIcon className="size-3" aria-hidden />
            Add server
          </Button>
        ) : null
      }
    >
      {environment && connected ? (
        <SharedMcpServerRows
          key={environment.environmentId}
          environment={environment}
          form={form}
          onFormChange={setForm}
        />
      ) : (
        <SettingsRow
          title={environment ? "Environment disconnected" : "Select one environment"}
          description={
            environment
              ? `Reconnect ${environment.label} to manage its shared MCP servers.`
              : environments.length > 1
                ? "Shared MCP servers belong to one environment. Select a single environment above."
                : "Connect an environment to manage its shared MCP servers."
          }
        />
      )}
    </SettingsSection>
  );
}

function SharedMcpServerRows({
  environment,
  form,
  onFormChange,
}: {
  readonly environment: EnvironmentPresentation;
  readonly form: FormState;
  readonly onFormChange: Dispatch<SetStateAction<FormState>>;
}) {
  const servers = useEnvironmentSettings(
    environment.environmentId,
    (settings) => settings.sharedMcpServers,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "shared MCP servers update",
  });
  // Each write replaces the whole list, so one runs at a time: a second built
  // from the same snapshot would undo the first.
  const [saving, setSaving] = useState(false);
  const save = async (sharedMcpServers: ReadonlyArray<SharedMcpServer>) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId: environment.environmentId,
      input: { patch: { sharedMcpServers: [...sharedMcpServers] } },
    });
    setSaving(false);
    return result._tag === "Success";
  };
  // A failed save keeps the form open, so nothing typed is lost; a late one
  // closes only the form that started it, not one opened since.
  const saveAndClose = (sharedMcpServers: ReadonlyArray<SharedMcpServer>) => {
    const started = form;
    void save(sharedMcpServers).then((saved) => {
      if (saved) onFormChange((current) => (current === started ? null : current));
    });
  };

  return (
    <>
      {servers.length === 0 && form === null ? (
        <SettingsRow
          title="No shared MCP servers"
          description="Add a server once and every new agent session gets it: Claude, Codex, Cursor, OpenCode, Pi, and ACP agents. Point it at a local MCP gateway to share many servers at once."
        />
      ) : null}
      {servers.map((server) =>
        form?.editing?.name === server.name ? (
          <SharedMcpServerForm
            key={server.name}
            servers={servers}
            editing={server}
            onCancel={() => onFormChange(null)}
            saving={saving}
            onSave={(next) => saveAndClose(upsertSharedMcpServer(servers, next, server))}
          />
        ) : (
          <SharedMcpServerRow
            key={server.name}
            environment={environment}
            server={server}
            saving={saving}
            onToggle={(enabled) =>
              void save(servers.map((entry) => (entry === server ? { ...entry, enabled } : entry)))
            }
            onEdit={() =>
              onFormChange({ environmentId: environment.environmentId, editing: server })
            }
            onRemove={() => void save(servers.filter((entry) => entry !== server))}
          />
        ),
      )}
      {form !== null && form.editing === undefined ? (
        <SharedMcpServerForm
          servers={servers}
          saving={saving}
          onCancel={() => onFormChange(null)}
          onSave={(next) => saveAndClose(upsertSharedMcpServer(servers, next))}
        />
      ) : null}
    </>
  );
}

function SharedMcpServerRow({
  environment,
  server,
  saving,
  onToggle,
  onEdit,
  onRemove,
}: {
  readonly environment: EnvironmentPresentation;
  readonly server: SharedMcpServer;
  readonly saving: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const testServer = useAtomCommand(serverEnvironment.testSharedMcpServer, {
    reportFailure: false,
  });
  const signInServer = useAtomCommand(serverEnvironment.signInSharedMcpServer, {
    reportFailure: false,
  });
  const openLink = useOpenLink(null);
  // The provider sends the browser back to this environment's server, which
  // keeps the tokens; agents never see them.
  const redirectBaseUrl = useEnvironmentHttpBaseUrl(environment.environmentId);
  const [test, setTest] = useState<
    | { readonly state: "running"; readonly message: string }
    | {
        readonly state: "done";
        readonly message: string;
        readonly ok: boolean;
        readonly needsSignIn?: boolean;
      }
    | null
  >(null);
  const headerCount = Object.keys(server.headers).length;
  const failed = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const failure = squashAtomCommandFailure(result);
    setTest({
      state: "done",
      ok: false,
      needsSignIn: isTestError(failure) && failure.needsSignIn,
      message: failure instanceof Error ? failure.message : String(failure),
    });
  };

  const runTest = async () => {
    setTest({ state: "running", message: "Testing…" });
    const result = await testServer({
      environmentId: environment.environmentId,
      input: { name: server.name },
    });
    if (result._tag === "Success") {
      const { serverName, toolCount } = result.value;
      setTest({
        state: "done",
        ok: true,
        message: `Connected${serverName ? ` to ${serverName}` : ""} · ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`,
      });
    } else if (isAtomCommandInterrupted(result)) {
      setTest(null);
    } else {
      failed(result);
    }
  };

  const signIn = async () => {
    if (redirectBaseUrl === null) return;
    setTest({ state: "running", message: "Starting sign-in…" });
    const result = await signInServer({
      environmentId: environment.environmentId,
      input: { name: server.name, redirectBaseUrl },
    });
    if (result._tag === "Success") {
      const { authorizationUrl } = result.value;
      if (authorizationUrl === null) {
        setTest({ state: "done", ok: true, message: "Connected · no sign-in needed" });
        return;
      }
      setTest({
        state: "done",
        ok: true,
        message: "Finish signing in in your browser, then test the connection.",
      });
      await openLink(authorizationUrl).catch((error: unknown) =>
        setTest({ state: "done", ok: false, message: String(error) }),
      );
    } else if (isAtomCommandInterrupted(result)) {
      setTest(null);
    } else {
      failed(result);
    }
  };

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-1.5">
          {server.name}
          {headerCount > 0 ? (
            <Badge size="sm" variant="outline">
              {headerCount} {headerCount === 1 ? "header" : "headers"}
            </Badge>
          ) : null}
        </span>
      }
      description={<span className="break-all font-mono">{server.url}</span>}
      status={
        test === null ? undefined : test.state === "running" ? (
          test.message
        ) : test.needsSignIn ? (
          <span className="flex items-center gap-2 text-destructive">
            Needs sign-in
            <Button size="xs" variant="outline" onClick={() => void signIn()}>
              Sign in
            </Button>
          </span>
        ) : (
          <span className={test.ok ? "text-success-foreground" : "text-destructive"}>
            {test.message}
          </span>
        )
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={server.enabled}
            disabled={saving}
            aria-label={`Share ${server.name} with agents`}
            onCheckedChange={onToggle}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={saving}
                  aria-label={`Actions for ${server.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={test?.state === "running"} onClick={() => void runTest()}>
                <PlugZapIcon />
                Test connection
              </MenuItem>
              <MenuItem disabled={test?.state === "running"} onClick={() => void signIn()}>
                <LogInIcon />
                Sign in
              </MenuItem>
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={onRemove}>
                <Trash2Icon />
                Remove
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}

function SharedMcpServerForm({
  servers,
  editing,
  saving,
  onCancel,
  onSave,
}: {
  readonly servers: ReadonlyArray<SharedMcpServer>;
  readonly editing?: SharedMcpServer;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (server: SharedMcpServer) => void;
}) {
  const [draft, setDraft] = useState<SharedMcpServerDraft>(() =>
    editing ? sharedMcpServerDraft(editing) : { name: "", url: "", headers: "" },
  );
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (saving) return;
    const parsed = parseSharedMcpServerDraft(servers, draft, editing);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    onSave(parsed.server);
  };
  const field = (key: keyof SharedMcpServerDraft) => ({
    value: draft[key],
    onChange: (event: { currentTarget: { value: string } }) => {
      // Read now: React clears `currentTarget` before a deferred updater runs.
      const value = event.currentTarget.value;
      setDraft((current) => ({ ...current, [key]: value }));
    },
  });

  return (
    <SettingsRow
      title={editing ? `Edit ${editing.name}` : "New MCP server"}
      description={
        error ??
        "Agents pick it up in their next session. Header values are stored as secrets; a server that uses OAuth signs in from its menu."
      }
      control={
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="xs" disabled={saving} onClick={submit}>
            {editing ? "Save" : "Add"}
          </Button>
        </div>
      }
    >
      <form
        className="grid gap-2 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-wrap gap-2">
          <Input
            className="w-40"
            size="sm"
            autoFocus
            placeholder="gateway"
            aria-label="Server name"
            {...field("name")}
          />
          <Input
            className="min-w-64 flex-1"
            size="sm"
            placeholder="http://127.0.0.1:3050/mcp"
            aria-label="Server URL"
            {...field("url")}
          />
        </div>
        <Textarea
          size="sm"
          rows={2}
          placeholder="Optional headers, one per line: Authorization: Bearer …"
          aria-label="Server headers"
          {...field("headers")}
        />
        <button type="submit" hidden />
      </form>
    </SettingsRow>
  );
}
