import { PLUGIN_CATALOG } from "@t3tools/client-runtime/state/kompas";
import type { Plugin, PluginState, PluginTransport } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { PlugIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { SidebarInset } from "../components/ui/sidebar";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { requestConfirmDialog } from "../confirmDialog";
import { randomUUID } from "../lib/utils";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { KompasPage, Panel, PanelTitle } from "./KompasPage";
import { type Kompas, kompasEnvironment, useKompas, useReportFailure } from "./state";

const toLines = (values: Readonly<Record<string, string>>, separator: string) =>
  Object.entries(values)
    .map(([name, value]) => `${name}${separator}${value}`)
    .join("\n");

const fromLines = (text: string, separator: string): Record<string, string> =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const at = line.indexOf(separator);
      const name = line.slice(0, at).trim();
      return at === -1 || name === ""
        ? []
        : [[name, line.slice(at + separator.length).trim()] as const];
    }),
  );

/** Splits a command line, keeping quoted arguments whole. */
const splitArgs = (text: string) =>
  [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );

function usePluginActions(kompas: Kompas) {
  const gt = useGT();
  const reportFailure = useReportFailure();
  const httpBaseUrl = useEnvironmentHttpBaseUrl(kompas.environmentId);
  const savePlugin = useAtomCommand(kompasEnvironment.savePlugin, { reportFailure: false });
  const removePlugin = useAtomCommand(kompasEnvironment.removePlugin, { reportFailure: false });
  const testPlugin = useAtomCommand(kompasEnvironment.testPlugin, { reportFailure: false });
  const signInPlugin = useAtomCommand(kompasEnvironment.signInPlugin, { reportFailure: false });
  const { environmentId } = kompas;
  const test = (id: string) => testPlugin({ environmentId, input: { id } });
  return {
    // The connection result lands in the snapshot, so its own failure needs no toast here.
    save: async (plugin: Plugin) => {
      const saved = reportFailure(await savePlugin({ environmentId, input: plugin }));
      if (saved && plugin.enabled) void test(plugin.id);
      return saved;
    },
    test: async (id: string) => reportFailure(await test(id)),
    signIn: async (id: string) => {
      const result = await signInPlugin({
        environmentId,
        input: { id, redirectBaseUrl: httpBaseUrl ?? window.location.origin },
      });
      if (!reportFailure(result) || result._tag !== "Success") return;
      if (result.value.authorizationUrl === null) void test(id);
      else window.open(result.value.authorizationUrl, "_blank", "noopener");
    },
    remove: async (plugin: PluginState) => {
      const confirmed = await requestConfirmDialog(
        gt("Remove {plugin} and its saved sign-in?", { plugin: plugin.label }),
      );
      if (confirmed === true) {
        reportFailure(await removePlugin({ environmentId, input: { id: plugin.id } }));
      }
    },
  };
}

/** The state carries fields the server owns; only the plugin itself is saved back. */
const asPlugin = ({ tools: _tools, needsSignIn: _signIn, error: _error, ...plugin }: PluginState) =>
  plugin;

function PluginEditor(props: {
  readonly kompas: Kompas;
  readonly plugin: Plugin;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { save } = usePluginActions(props.kompas);
  const { transport } = props.plugin;
  const [label, setLabel] = useState(props.plugin.label);
  const [type, setType] = useState(transport.type);
  const [url, setUrl] = useState(transport.type === "http" ? transport.url : "");
  const [headers, setHeaders] = useState(
    transport.type === "http" ? toLines(transport.headers, ": ") : "",
  );
  const [command, setCommand] = useState(
    transport.type === "stdio"
      ? [transport.command, ...transport.args]
          .map((part) => (/\s/.test(part) ? `"${part}"` : part))
          .join(" ")
      : "",
  );
  const [env, setEnv] = useState(transport.type === "stdio" ? toLines(transport.env, "=") : "");
  const [busy, setBusy] = useState(false);
  const [program, ...args] = splitArgs(command);
  const next: PluginTransport | null =
    type === "http"
      ? /^https?:\/\/\S+$/.test(url.trim())
        ? { type: "http", url: url.trim(), headers: fromLines(headers, ":") }
        : null
      : program === undefined
        ? null
        : { type: "stdio", command: program, args, env: fromLines(env, "=") };
  const name =
    props.plugin.name !== ""
      ? props.plugin.name
      : label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 24);

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {props.plugin.name === "" ? gt("Add plugin") : props.plugin.label}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <T>Name</T>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
            <ToggleGroup
              value={[type]}
              onValueChange={(value) => {
                const [picked] = value;
                if (picked === "http" || picked === "stdio") setType(picked);
              }}
            >
              <Toggle value="http">
                <T>Web address</T>
              </Toggle>
              <Toggle value="stdio">
                <T>Command on this computer</T>
              </Toggle>
            </ToggleGroup>
            {type === "http" ? (
              <>
                <label className="flex flex-col gap-1.5 text-sm">
                  <T>MCP address</T>
                  <Input
                    value={url}
                    placeholder={gt("For example {value}", {
                      value: "https://mcp.example.com/mcp",
                    })}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  <T>Headers, one per line</T>
                  <Textarea
                    rows={3}
                    spellCheck={false}
                    value={headers}
                    placeholder={gt("For example {value}", { value: "x-api-key: 1234" })}
                    onChange={(event) => setHeaders(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1.5 text-sm">
                  <T>Command</T>
                  <Input
                    value={command}
                    placeholder={gt("For example {value}", { value: "npx -y some-mcp-server" })}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  <T>Environment variables, one per line</T>
                  <Textarea
                    rows={3}
                    spellCheck={false}
                    value={env}
                    placeholder={gt("For example {value}", { value: "API_KEY=1234" })}
                    onChange={(event) => setEnv(event.target.value)}
                  />
                </label>
              </>
            )}
            <p className="text-muted-foreground text-sm">
              <T>
                Keys stay in this computer's secret store. Models never see them. Leave dots in
                place to keep a saved key.
              </T>
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            disabled={busy || next === null || name === "" || label.trim() === ""}
            onClick={() => {
              if (next === null) return;
              setBusy(true);
              void save({ ...props.plugin, name, label: label.trim(), transport: next }).then(
                (saved) => {
                  setBusy(false);
                  if (saved) props.onClose();
                },
              );
            }}
          >
            <T>Save</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const newPlugin = (
  name: string,
  label: string,
  transport: PluginTransport = { type: "http", url: "", headers: {} },
): Plugin => ({
  id: randomUUID(),
  name,
  label,
  enabled: true,
  allConversations: true,
  transport,
  disabledTools: [],
});

function PluginCard(props: {
  readonly kompas: Kompas;
  readonly plugin: PluginState;
  readonly onEdit: () => void;
}) {
  const gt = useGT();
  const { plugin } = props;
  const actions = usePluginActions(props.kompas);
  const [busy, setBusy] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const run = (action: Promise<unknown>) => {
    setBusy(true);
    void action.finally(() => setBusy(false));
  };
  const enabledTools = plugin.tools.filter((tool) => !plugin.disabledTools.includes(tool.name));
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3">
        <PlugIcon className="size-5 text-primary" />
        <div className="min-w-40 flex-1">
          <h2 className="font-semibold">{plugin.label}</h2>
          <p className="truncate text-muted-foreground text-sm">
            {plugin.transport.type === "http"
              ? plugin.transport.url
              : [plugin.transport.command, ...plugin.transport.args].join(" ")}
          </p>
        </div>
        {plugin.needsSignIn ? (
          <Badge variant="warning">
            <T>Sign in needed</T>
          </Badge>
        ) : plugin.error !== null ? (
          <Badge variant="error">
            <T>Not connected</T>
          </Badge>
        ) : plugin.tools.length > 0 ? (
          <Badge variant="success">
            {gt("{enabled} of {total} tools", {
              enabled: enabledTools.length,
              total: plugin.tools.length,
            })}
          </Badge>
        ) : null}
        <Switch
          aria-label={gt("{plugin} on", { plugin: plugin.label })}
          checked={plugin.enabled}
          onCheckedChange={(enabled) => void actions.save({ ...asPlugin(plugin), enabled })}
        />
      </div>
      {plugin.error === null ? null : (
        <p className="mt-2 text-destructive-foreground text-sm">{plugin.error}</p>
      )}
      <label className="mt-4 flex items-center gap-2 text-sm">
        <Switch
          size="sm"
          checked={plugin.allConversations}
          onCheckedChange={(allConversations) =>
            void actions.save({ ...asPlugin(plugin), allConversations })
          }
        />
        <T>On in every conversation</T>
      </label>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run(actions.test(plugin.id))}
        >
          <T>Test connection</T>
        </Button>
        {plugin.transport.type === "http" ? (
          <Button
            size="sm"
            variant={plugin.needsSignIn ? "default" : "outline"}
            disabled={busy}
            onClick={() => run(actions.signIn(plugin.id))}
          >
            <T>Sign in</T>
          </Button>
        ) : null}
        {plugin.tools.length === 0 ? null : (
          <Button size="sm" variant="outline" onClick={() => setShowTools(!showTools)}>
            {showTools ? <T>Hide tools</T> : <T>Choose tools</T>}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={props.onEdit}>
          <T>Edit</T>
        </Button>
        <Button
          size="icon-sm"
          variant="ghost-destructive"
          aria-label={gt("Remove {plugin}", { plugin: plugin.label })}
          onClick={() => void actions.remove(plugin)}
        >
          <Trash2Icon />
        </Button>
      </div>
      {showTools ? (
        <ul className="mt-4 flex flex-col gap-3 border-border border-t pt-4">
          {plugin.tools.map((tool) => (
            <li key={tool.name} className="flex items-start gap-3">
              <Switch
                size="sm"
                aria-label={tool.name}
                checked={!plugin.disabledTools.includes(tool.name)}
                onCheckedChange={(on) =>
                  void actions.save({
                    ...asPlugin(plugin),
                    disabledTools: on
                      ? plugin.disabledTools.filter((name) => name !== tool.name)
                      : [...plugin.disabledTools, tool.name],
                  })
                }
              />
              <div className="min-w-0">
                <p className="font-medium text-sm">{tool.title ?? tool.name}</p>
                <p className="line-clamp-2 text-muted-foreground text-sm">{tool.description}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

export function PluginsPage() {
  const kompas = useKompas();
  const [editing, setEditing] = useState<Plugin | null>(null);
  if (kompas === null) return <SidebarInset className="h-dvh" />;
  return <PluginsContent kompas={kompas} editing={editing} onEdit={setEditing} />;
}

function PluginsContent(props: {
  readonly kompas: Kompas;
  readonly editing: Plugin | null;
  readonly onEdit: (plugin: Plugin | null) => void;
}) {
  const { kompas } = props;
  const gt = useGT();
  const { plugins } = kompas.snapshot;
  const { save } = usePluginActions(kompas);
  const addable = PLUGIN_CATALOG.filter(
    (entry) => !plugins.some((plugin) => plugin.name === entry.name),
  );
  return (
    <KompasPage
      title={gt("Plugins")}
      description={gt(
        "Add a plugin once and every model can use it, from the next conversation on.",
      )}
      actions={
        <Button variant="outline" onClick={() => props.onEdit(newPlugin("", ""))}>
          <PlusIcon />
          <T>Add your own</T>
        </Button>
      }
    >
      {addable.length === 0 ? null : (
        <div className="grid gap-3 sm:grid-cols-2">
          {addable.map((entry) => {
            const transport = { type: "http" as const, url: entry.url, headers: {} };
            return (
              <Panel key={entry.name}>
                <PanelTitle
                  detail={gt("Web search for any model. Works without a key, within a free limit.")}
                >
                  {entry.brand}
                </PanelTitle>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void save(newPlugin(entry.name, entry.brand, transport))}
                  >
                    <T>Add</T>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      props.onEdit(
                        newPlugin(entry.name, entry.brand, {
                          ...transport,
                          headers: { [entry.keyHeader]: entry.keyPrefix },
                        }),
                      )
                    }
                  >
                    <T>Add with a key</T>
                  </Button>
                  <Button
                    size="sm"
                    variant="link"
                    render={<a href={entry.docs} target="_blank" rel="noreferrer" />}
                  >
                    <T>
                      About <Var>{entry.brand}</Var>
                    </T>
                  </Button>
                </div>
              </Panel>
            );
          })}
        </div>
      )}
      {plugins.map((plugin) => (
        <PluginCard
          key={plugin.id}
          kompas={kompas}
          plugin={plugin}
          onEdit={() => props.onEdit(asPlugin(plugin))}
        />
      ))}
      {props.editing === null ? null : (
        <PluginEditor
          key={props.editing.id}
          kompas={kompas}
          plugin={props.editing}
          onClose={() => props.onEdit(null)}
        />
      )}
    </KompasPage>
  );
}
