import { Link } from "@tanstack/react-router";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  MoreHorizontalIcon,
  PuzzleIcon,
  RotateCwIcon,
  DownloadIcon,
  Trash2Icon,
  Settings2Icon,
} from "lucide-react";
import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { ExtensionSettingsFields } from "./ExtensionSettingsFields";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ExtensionInfo } from "@t3tools/contracts";
import { extensionEnvironment, extensionClientSurface } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ExtensionPanel } from "./ExtensionPanel";

export function ExtensionCard({
  environmentId,
  entry,
}: {
  environmentId: EnvironmentId;
  entry: ExtensionInfo;
}) {
  const manage = useAtomCommand(extensionEnvironment.manage);
  const settings = useAtomCommand(extensionEnvironment.settings);
  const invoke = useAtomCommand(extensionEnvironment.invoke);
  const panel = useAtomCommand(extensionEnvironment.panel);
  const permission = useAtomValue(extensionEnvironment.manage.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [opened, setOpened] = useState<{
    title: string;
    html: string;
    runtimeId: string | undefined;
  } | null>(null);
  const [argumentsText, setArgumentsText] = useState("{}");
  const run = async (operation: () => Promise<void | AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (result) extensionCommandValue(result);
    } catch (error) {
      setError(extensionFailureMessage(error));
    }
    setBusy(false);
  };
  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
      <div className="flex items-start gap-3 p-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <PuzzleIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{entry.manifest.name}</h3>
            <span className="text-xs text-muted-foreground">v{entry.manifest.version}</span>
            <Badge
              variant={
                entry.status === "running"
                  ? "success"
                  : entry.status === "failed"
                    ? "error"
                    : entry.status === "starting"
                      ? "warning"
                      : "secondary"
              }
            >
              {entry.status === "running"
                ? "Running"
                : entry.status === "failed"
                  ? "Failed"
                  : entry.status === "starting"
                    ? "Starting"
                    : "Disabled"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{entry.manifest.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            aria-label={`Enable ${entry.manifest.name}`}
            checked={entry.enabled}
            disabled={busy || !permission}
            onCheckedChange={(enabled) =>
              void run(() =>
                manage({
                  environmentId,
                  input: { id: entry.manifest.id, action: enabled ? "enable" : "disable" },
                }),
              )
            }
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Actions for ${entry.manifest.name}`}
                  disabled={busy || !permission}
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                disabled={!entry.enabled}
                onClick={() =>
                  void run(() =>
                    manage({ environmentId, input: { id: entry.manifest.id, action: "reload" } }),
                  )
                }
              >
                <RotateCwIcon />
                Reload
              </MenuItem>
              {entry.sourceType === "npm" && (
                <MenuItem
                  onClick={() =>
                    void run(() =>
                      manage({ environmentId, input: { id: entry.manifest.id, action: "update" } }),
                    )
                  }
                >
                  <DownloadIcon />
                  Update package
                </MenuItem>
              )}
              <MenuItem
                variant="destructive"
                onClick={() =>
                  void run(() =>
                    manage({
                      environmentId,
                      input: { id: entry.manifest.id, action: "uninstall" },
                    }),
                  )
                }
              >
                <Trash2Icon />
                Uninstall
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <div className="space-y-3 px-4 pb-4">
        {(entry.diagnostic || error) && (
          <p
            role="alert"
            className="break-words rounded-lg bg-destructive/8 p-3 text-sm text-destructive-foreground"
          >
            {error ?? entry.diagnostic}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {entry.enabled &&
            entry.manifest.settingsPages?.map((page) => (
              <Button
                key={page.id}
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/settings/extension/$extensionId/$pageId"
                    params={{ extensionId: entry.manifest.id, pageId: page.id }}
                  />
                }
              >
                <Settings2Icon />
                {(entry.manifest.settingsPages?.length ?? 0) === 1 ? "Settings" : page.title}
              </Button>
            ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {entry.manifest.panels?.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant="outline"
              disabled={entry.status !== "running" || !permission}
              onClick={() =>
                void run(async () => {
                  const result = await panel({
                    environmentId,
                    input: { id: entry.manifest.id, panelId: item.id, runtimeId: entry.runtimeId },
                  });
                  setOpened({
                    title: item.title,
                    html: extensionCommandValue(result),
                    runtimeId: entry.runtimeId,
                  });
                })
              }
            >
              Open {item.title}
            </Button>
          ))}
        </div>
        {Object.keys(entry.manifest.settings ?? {}).length > 0 && (
          <details className="rounded-lg border border-border/60 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Extension settings</summary>
            <div className="space-y-4 pt-4">
              <ExtensionSettingsFields
                entry={entry}
                disabled={busy || !permission}
                save={(key, value) =>
                  void run(() =>
                    settings({
                      environmentId,
                      input: { id: entry.manifest.id, settings: { [key]: value } },
                    }),
                  )
                }
              />
            </div>
          </details>
        )}
        {(entry.manifest.commands?.length ?? 0) > 0 && (
          <details className="rounded-lg border border-border/60 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Advanced commands</summary>
            <div className="space-y-3 pt-3">
              <p className="text-xs text-muted-foreground">
                Run commands directly with JSON arguments. Commands are also available in the
                command palette.
              </p>
              {(entry.manifest.commands?.length ?? 0) > 0 && (
                <Input
                  aria-label="Command arguments (JSON)"
                  value={argumentsText}
                  onChange={(event) => setArgumentsText(event.target.value)}
                />
              )}
              <div className="flex flex-wrap gap-2">
                {entry.manifest.commands?.map((command) => (
                  <Button
                    key={command.id}
                    size="sm"
                    variant="secondary"
                    disabled={busy || entry.status !== "running" || !permission}
                    title={command.description}
                    onClick={() =>
                      void run(async () => {
                        let input: unknown;
                        try {
                          input = JSON.parse(argumentsText);
                        } catch {
                          setError("Enter valid JSON arguments.");
                          return;
                        }
                        const result = await invoke({
                          environmentId,
                          input: {
                            id: entry.manifest.id,
                            kind: "command",
                            name: command.id,
                            input,
                            context: { surface: extensionClientSurface },
                          },
                        });
                        setOutput(JSON.stringify(extensionCommandValue(result), null, 2));
                      })
                    }
                  >
                    {command.title}
                  </Button>
                ))}
              </div>
              {output && (
                <pre role="status" className="max-h-56 overflow-auto rounded bg-muted p-3 text-xs">
                  {output}
                </pre>
              )}
            </div>
          </details>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Installation details</summary>
          <div className="space-y-1 pt-2">
            <p>{entry.manifest.id}</p>
            <p className="break-all">
              {entry.sourceType === "local" ? "Local folder" : "npm package"}: {entry.source}
            </p>
          </div>
        </details>
        {opened && entry.status === "running" && opened.runtimeId === entry.runtimeId && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setOpened(null)}>
              Close {opened.title}
            </Button>
            <ExtensionPanel
              key={opened.html}
              environmentId={environmentId}
              entry={entry}
              html={opened.html}
              title={opened.title}
            />
          </>
        )}
      </div>
    </section>
  );
}
