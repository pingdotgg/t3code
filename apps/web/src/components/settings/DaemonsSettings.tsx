import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type Daemon,
  type EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  ServerCogIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { T, useGT, Var } from "gt-react";
import { lazy, type ReactNode, Suspense, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { daemonsEnvironment } from "../../state/daemons";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot, connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { EnvironmentRow } from "./EnvironmentRow";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { ScheduledRelativeLabel } from "./ScheduledTasksSettings";

const DaemonsTerminal = lazy(() => import("./DaemonsTerminal"));

type Editor = { readonly environmentId: EnvironmentId; readonly daemon: Daemon | null };

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

export function DaemonsSettings() {
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [terminal, setTerminal] = useState<{
    readonly environmentId: EnvironmentId;
    readonly daemon: Daemon;
  } | null>(null);
  const setting = useSearchableSetting();
  const gt = useGT();
  const creationEnvironment = environment ?? connectedEnvironments[0];
  return (
    <SettingsPageContainer>
      <SettingsSection
        {...setting("daemons")}
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!creationEnvironment}
            onClick={() =>
              creationEnvironment &&
              setEditor({ environmentId: creationEnvironment.environmentId, daemon: null })
            }
          >
            <PlusIcon className="size-3" />
            <T>New daemon</T>
          </Button>
        }
      >
        {scope.kind === "unavailable" ? (
          <SettingsSection title={gt("Unavailable selection")}>
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerCogIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>No environments available</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Connect an environment to manage its daemons.</T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SettingsGroup>
            {environments.map((entry) => (
              <DaemonEnvironmentGroup
                key={entry.environmentId}
                environment={entry}
                environments={environments}
                onEdit={(daemon) => setEditor({ environmentId: entry.environmentId, daemon })}
                onOpenTerminal={(daemon) =>
                  setTerminal({ environmentId: entry.environmentId, daemon })
                }
              />
            ))}
          </SettingsGroup>
        )}
      </SettingsSection>
      {editor ? (
        <DaemonEditorDialog
          key={`${editor.environmentId}:${editor.daemon?.id ?? "new"}`}
          initial={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {terminal ? (
        <Dialog open onOpenChange={(open) => !open && setTerminal(null)}>
          <DialogPopup className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>{terminal.daemon.name}</DialogTitle>
              <DialogDescription>
                <span className="font-mono">{terminal.daemon.command}</span>
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <Suspense fallback={<div className="h-[60vh]" />}>
                <DaemonsTerminal
                  environmentId={terminal.environmentId}
                  daemonId={terminal.daemon.id}
                />
              </Suspense>
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button size="sm" />}>
                <T>Done</T>
              </DialogClose>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </SettingsPageContainer>
  );
}

function DaemonEnvironmentGroup({
  environment,
  environments,
  onEdit,
  onOpenTerminal,
}: {
  readonly environment: EnvironmentPresentation;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly onEdit: (daemon: Daemon) => void;
  readonly onOpenTerminal: (daemon: Daemon) => void;
}) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const query = useEnvironmentQuery(
    connected
      ? daemonsEnvironment.live({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  const gt = useGT();
  const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
  const daemons = query.data?.daemons;
  return (
    <div className="divide-y divide-border/50">
      <EnvironmentRow
        kind={resolveEnvironmentMachineKind(environment.serverConfig)}
        label={primary}
        subtitle={secondary}
      >
        <ConnectionStatusDot
          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
          tooltipText={connectionStatusTitle(environment.connection)}
        />
        <span className="text-xs text-muted-foreground">
          {connectionStatusTitle(environment.connection)}
        </span>
      </EnvironmentRow>
      {!connected ? null : query.error ? (
        <SettingsRow title={gt("Could not load daemons")} description={query.error} />
      ) : !daemons ? (
        <SettingsRow title={gt("Loading daemons…")} role="status" />
      ) : daemons.length === 0 ? (
        <SettingsRow
          title={gt("No daemons")}
          description={gt("Nothing runs in the background here.")}
        />
      ) : (
        daemons.map((daemon) => (
          <DaemonRow
            key={daemon.id}
            environmentId={environment.environmentId}
            daemon={daemon}
            onEdit={() => onEdit(daemon)}
            onOpenTerminal={() => onOpenTerminal(daemon)}
          />
        ))
      )}
    </div>
  );
}

function DaemonStatusLabel({ daemon }: { readonly daemon: Daemon }) {
  const gt = useGT();
  const { status } = daemon;
  const exit =
    status.lastExitCode !== null
      ? gt("last exit code {code}", { code: status.lastExitCode })
      : status.lastError;
  switch (status.state) {
    case "running":
      return (
        <>
          <Badge variant="success">
            <T context="daemon state">running</T>
          </Badge>
          {status.pid !== null ? <span>{gt("pid {pid}", { pid: status.pid })}</span> : null}
          {status.startedAt ? (
            <T>
              <span>
                since{" "}
                <Var>
                  <ScheduledRelativeLabel value={status.startedAt} />
                </Var>
              </span>
            </T>
          ) : null}
        </>
      );
    case "restarting":
      return (
        <>
          <Badge variant="warning">
            <T context="daemon state">restarting</T>
          </Badge>
          {status.nextAttemptAt ? (
            <T>
              <span>
                next attempt{" "}
                <Var>
                  <ScheduledRelativeLabel value={status.nextAttemptAt} />
                </Var>
              </span>
            </T>
          ) : null}
          {exit ? <span>{exit}</span> : null}
        </>
      );
    case "stopped":
      return (
        <>
          <Badge variant="outline">
            <T context="daemon state">stopped</T>
          </Badge>
          {exit ? <span>{exit}</span> : null}
        </>
      );
  }
}

function DaemonRow({
  environmentId,
  daemon,
  onEdit,
  onOpenTerminal,
}: {
  readonly environmentId: EnvironmentId;
  readonly daemon: Daemon;
  readonly onEdit: () => void;
  readonly onOpenTerminal: () => void;
}) {
  const gt = useGT();
  const canOperate = useAtomValue(daemonsEnvironment.upsert.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const upsert = useAtomCommand(daemonsEnvironment.upsert, { label: "daemon enable" });
  const restart = useAtomCommand(daemonsEnvironment.restart, { label: "daemon restart" });
  const remove = useAtomCommand(daemonsEnvironment.delete, { label: "daemon delete" });
  const act = async (action: "toggle" | "restart" | "delete") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    if (action === "delete") {
      const message = gt('Delete "{name}"?\nIts process stops and its output is discarded.', {
        name: daemon.name,
      });
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setBusy(true);
    const { status: _status, ...definition } = daemon;
    const result =
      action === "toggle"
        ? await upsert({ environmentId, input: { ...definition, enabled: !daemon.enabled } })
        : action === "restart"
          ? await restart({ environmentId, input: { id: daemon.id } })
          : await remove({ environmentId, input: { id: daemon.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not update daemon"), squashAtomCommandFailure(result));
    }
  };
  return (
    <SettingsRow
      title={daemon.name}
      description={<span className="block truncate font-mono text-xs">{daemon.command}</span>}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <DaemonStatusLabel daemon={daemon} />
          <span className="truncate font-mono">{daemon.cwd}</span>
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={daemon.status.state === "stopped"}
            onClick={onOpenTerminal}
          >
            <SquareTerminalIcon className="size-3" />
            <T>Terminal</T>
          </Button>
          <Switch
            checked={daemon.enabled}
            disabled={busy || !canOperate}
            aria-label={gt("Enable {name}", { name: daemon.name })}
            onCheckedChange={() => void act("toggle")}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !canOperate}
                  aria-label={gt("Actions for {name}", { name: daemon.name })}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                <T>Edit</T>
              </MenuItem>
              <MenuItem disabled={!daemon.enabled} onClick={() => void act("restart")}>
                <RotateCwIcon />
                <T>Restart</T>
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => void act("delete")}>
                <Trash2Icon />
                <T>Delete</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function DaemonEditorDialog({
  initial,
  onClose,
}: {
  readonly initial: Editor;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initial.environmentId);
  const [name, setName] = useState(initial.daemon?.name ?? "");
  const [command, setCommand] = useState(initial.daemon?.command ?? "");
  const [cwd, setCwd] = useState(initial.daemon?.cwd ?? "");
  const [enabled, setEnabled] = useState(initial.daemon?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const canOperate = useAtomValue(daemonsEnvironment.upsert.permissionAtom(environmentId));
  const upsert = useAtomCommand(daemonsEnvironment.upsert, { label: "daemon upsert" });
  const environment = connectedEnvironments.find((entry) => entry.environmentId === environmentId);
  const complete = name.trim() !== "" && command.trim() !== "" && cwd.trim() !== "";

  const submit = async () => {
    if (saving || !complete || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    setSaving(true);
    const result = await upsert({
      environmentId,
      input: {
        ...(initial.daemon ? { id: initial.daemon.id } : {}),
        name: name.trim(),
        command: command.trim(),
        cwd: cwd.trim(),
        enabled,
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(gt("Could not save daemon"), squashAtomCommandFailure(result));
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial.daemon ? gt("Edit daemon") : gt("New daemon")}</DialogTitle>
          <DialogDescription>
            <T>
              A shell command this server keeps running. It starts when the server starts and
              restarts after it exits.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="min-w-0 space-y-5">
            <Field label={gt("Runs on")} htmlFor="daemon-environment">
              <Select
                value={environmentId}
                disabled={initial.daemon !== null}
                onValueChange={(id) => {
                  const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                  if (next) setEnvironmentId(next.environmentId);
                }}
              >
                <SelectTrigger id="daemon-environment" size="sm">
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                        className="size-4"
                      />
                      {environment?.label ?? gt("Unavailable environment")}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connectedEnvironments.map((entry) => (
                    <SelectItem
                      key={entry.environmentId}
                      value={entry.environmentId}
                      label={entry.label}
                    >
                      <span className="flex items-center gap-2">
                        <EnvironmentMachineIcon
                          kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                          className="size-4"
                        />
                        {entry.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label={gt("Name")} htmlFor="daemon-name">
              <Input
                id="daemon-name"
                value={name}
                placeholder="maestro"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field
              label={gt("Command")}
              htmlFor="daemon-command"
              hint={gt("Runs with {shell}.", { shell: "sh -c" })}
            >
              <Textarea
                id="daemon-command"
                value={command}
                placeholder="./queue.sh --loop ~/projects/app"
                onChange={(event) => setCommand(event.target.value)}
              />
            </Field>
            <Field
              label={gt("Working folder")}
              htmlFor="daemon-cwd"
              hint={gt("An absolute path on the machine that runs the daemon.")}
            >
              <Input
                id="daemon-cwd"
                value={cwd}
                placeholder="/home/me/projects/app"
                onChange={(event) => setCwd(event.target.value)}
              />
            </Field>
            <div className="flex items-center justify-between">
              <Label htmlFor="daemon-enabled">
                <T>Enabled</T>
              </Label>
              <Switch
                id="daemon-enabled"
                checked={enabled}
                onCheckedChange={(checked) => setEnabled(checked)}
              />
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button
            size="sm"
            disabled={saving || !complete || !canOperate || environment === undefined}
            onClick={() => void submit()}
          >
            <T>Save</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
