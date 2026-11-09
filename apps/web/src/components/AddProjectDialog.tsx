import {
  canCreateProjectInEnvironment,
  getAddProjectInitialQuery,
} from "@t3tools/client-runtime/operations/projects";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
  isExplicitRelativeProjectPath,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type DesktopDiscoveredSshHost,
  type EnvironmentId,
  FilesystemBrowseError,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { ChevronRightIcon, CornerLeftUpIcon, FolderIcon, TerminalIcon } from "lucide-react";
import { type KeyboardEvent, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { openCommandPalette } from "../commandPaletteBus";
import { connectSshEnvironment as connectSshEnvironmentAtom } from "../connection/onboarding";
import { useAddProjectAtPath } from "../hooks/useAddProjectAtPath";
import { cn } from "../lib/utils";
import { desktopSshHostsStateAtom } from "../state/desktopSshHosts";
import {
  type EnvironmentPresentation,
  readEnvironment,
  useEnvironments,
} from "../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../state/filesystem";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { getEnvironmentBrowsePlatform } from "./CommandPalette.logic";
import { ConnectionStatusDot, connectionPhaseDotClassName } from "./ConnectionStatusDot";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { formatDesktopSshConnectionError } from "./settings/ConnectionsSettings.logic";
import { formatDesktopSshTarget, unsavedDesktopSshHosts } from "./settings/EnvironmentRow";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

const useAddProjectDialog = create<{
  open: boolean;
  session: number;
  /** The machine an in-flight add targets. */
  submitting: EnvironmentId | null;
}>(() => ({ open: false, session: 0, submitting: null }));

/** Opens the dialog that adds a project: pick a machine, then a folder on it. */
export function openAddProjectDialog() {
  useAddProjectDialog.setState((state) =>
    state.open ? state : { open: true, session: state.session + 1, submitting: null },
  );
}

function closeAddProjectDialog() {
  useAddProjectDialog.setState({ open: false });
}

export function AddProjectDialogHost() {
  const open = useAddProjectDialog((state) => state.open);
  const session = useAddProjectDialog((state) => state.session);
  return open ? <AddProjectDialog key={session} /> : null;
}

type Step =
  | { readonly kind: "machine"; readonly error: string | null }
  | { readonly kind: "connecting"; readonly host: DesktopDiscoveredSshHost }
  | { readonly kind: "folder"; readonly environmentId: EnvironmentId };

const isFilesystemBrowseError = Schema.is(FilesystemBrowseError);

// Only absolute and ~/ paths: a bare or ./ name would land in the server's working folder.
function isHostPath(value: string, platform: string) {
  const { isBrowsing, filterQuery } = getFilesystemBrowsePath(value, platform);
  return (
    isBrowsing &&
    !isExplicitRelativeProjectPath(value) &&
    filterQuery !== "." &&
    filterQuery !== ".."
  );
}
const EMPTY_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];

// Cloning and empty projects stay in the palette's add-project flow.
function openOtherSources() {
  closeAddProjectDialog();
  openCommandPalette({ open: "add-project" });
}

function isPrimaryEnvironment(environment: EnvironmentPresentation) {
  return environment.entry.target._tag === "PrimaryConnectionTarget";
}

function environmentLabel(environment: EnvironmentPresentation) {
  return resolveEnvironmentOptionLabel({
    isPrimary: isPrimaryEnvironment(environment),
    environmentId: environment.environmentId,
    runtimeLabel: environment.label,
  });
}

function AddProjectDialog() {
  const { environments } = useEnvironments();
  const hasDesktopBridge = typeof window !== "undefined" && window.desktopBridge !== undefined;
  // On the web with a single connected machine there is nothing to pick.
  const [step, setStep] = useState<Step>(() =>
    !hasDesktopBridge &&
    environments.length === 1 &&
    environments[0] &&
    canCreateProjectInEnvironment(environments[0].connection.phase)
      ? { kind: "folder", environmentId: environments[0].environmentId }
      : { kind: "machine", error: null },
  );
  const connectAttempt = useRef(0);
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });

  const connectHost = async (host: DesktopDiscoveredSshHost) => {
    const attempt = ++connectAttempt.current;
    setStep({ kind: "connecting", host });
    const result = await connectSshEnvironment({
      target: {
        alias: host.alias,
        hostname: host.hostname,
        username: host.username,
        port: host.port,
      },
      label: "",
    });
    if (attempt !== connectAttempt.current) return;
    if (result._tag === "Failure") {
      setStep({
        kind: "machine",
        error: isAtomCommandInterrupted(result)
          ? null
          : formatDesktopSshConnectionError(squashAtomCommandFailure(result)),
      });
      return;
    }
    setStep({ kind: "folder", environmentId: result.value });
  };

  const backToMachines = () => {
    connectAttempt.current += 1;
    setStep({ kind: "machine", error: null });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        // An add in flight navigates when it lands, so the dialog stays until then,
        // unless its machine dropped and the add may never land.
        const { submitting } = useAddProjectDialog.getState();
        if (
          submitting === null ||
          !canCreateProjectInEnvironment(readEnvironment(submitting)?.connection.phase)
        ) {
          closeAddProjectDialog();
        }
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        {step.kind === "folder" ? (
          <FolderStep
            environment={
              environments.find((candidate) => candidate.environmentId === step.environmentId) ??
              null
            }
            onBack={backToMachines}
          />
        ) : (
          <MachineStep
            environments={environments}
            hasDesktopBridge={hasDesktopBridge}
            connectingHost={step.kind === "connecting" ? step.host : null}
            error={step.kind === "machine" ? step.error : null}
            onPickEnvironment={(environmentId) => setStep({ kind: "folder", environmentId })}
            onPickSshHost={(host) => void connectHost(host)}
            onCancelConnect={backToMachines}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function MachineStep({
  environments,
  hasDesktopBridge,
  connectingHost,
  error,
  onPickEnvironment,
  onPickSshHost,
  onCancelConnect,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  hasDesktopBridge: boolean;
  connectingHost: DesktopDiscoveredSshHost | null;
  error: string | null;
  onPickEnvironment: (environmentId: EnvironmentId) => void;
  onPickSshHost: (host: DesktopDiscoveredSshHost) => void;
  onCancelConnect: () => void;
}) {
  const sshHosts = useEnvironmentQuery(hasDesktopBridge ? desktopSshHostsStateAtom : null);
  const refreshSshHosts = sshHosts.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rereads ~/.ssh/config through the desktop bridge each time the machine list is shown
  useEffect(() => {
    if (hasDesktopBridge) refreshSshHosts();
  }, [hasDesktopBridge, refreshSshHosts]);
  const newSshHosts = unsavedDesktopSshHosts(
    (sshHosts.data ?? EMPTY_SSH_HOSTS).filter((host) => host.source === "ssh-config"),
    environments,
  );
  const navigate = useNavigate();
  const openConnectionSettings = () => {
    closeAddProjectDialog();
    void navigate({ to: "/settings/connections" });
  };
  const noMachine =
    newSshHosts.length === 0 &&
    !sshHosts.isPending &&
    !environments.some(
      ({ connection: { phase } }) =>
        canCreateProjectInEnvironment(phase) || phase === "connecting" || phase === "reconnecting",
    );
  const sortedEnvironments = environments.toSorted((left, right) => {
    const leftPrimary = isPrimaryEnvironment(left);
    if (leftPrimary !== isPrimaryEnvironment(right)) return leftPrimary ? -1 : 1;
    return environmentLabel(left).localeCompare(environmentLabel(right));
  });

  if (connectingHost) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Connecting to {connectingHost.alias}…</DialogTitle>
          <DialogDescription>
            The first time, this installs T3 Code on {connectingHost.alias}. It can take a minute.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner size="md" />
            <span className="truncate font-mono text-xs">
              {formatDesktopSshTarget(connectingHost)}
            </span>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancelConnect}>
            Back
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add project</DialogTitle>
        <DialogDescription>Where is the project?</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {(error ?? sshHosts.error) ? (
          <Alert variant="error">
            <AlertDescription>{error ?? sshHosts.error}</AlertDescription>
          </Alert>
        ) : null}
        {noMachine ? (
          <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-muted-foreground text-sm">
            No connected machine can add a project.
            <Button type="button" size="sm" variant="outline" onClick={openConnectionSettings}>
              Connect a machine
            </Button>
          </div>
        ) : null}
        <div className="flex max-h-80 flex-col overflow-y-auto rounded-md border">
          {sortedEnvironments.map((environment) => {
            const connected = canCreateProjectInEnvironment(environment.connection.phase);
            return (
              <PickerRow
                key={environment.environmentId}
                disabled={!connected}
                onClick={() => onPickEnvironment(environment.environmentId)}
                icon={
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                    className="size-4 shrink-0"
                  />
                }
                title={environmentLabel(environment)}
                detail={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ConnectionStatusDot
                      dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                    />
                    <span className="truncate">
                      {hasDesktopBridge && isPrimaryEnvironment(environment) && connected
                        ? "This computer"
                        : connectionStatusText(environment.connection)}
                    </span>
                  </span>
                }
              />
            );
          })}
          {newSshHosts.map((host) => (
            <PickerRow
              key={`ssh:${host.alias}:${formatDesktopSshTarget(host)}`}
              onClick={() => onPickSshHost(host)}
              icon={<TerminalIcon className="size-4 shrink-0" />}
              title={host.alias}
              detail={`SSH · ${formatDesktopSshTarget(host)} · not connected yet`}
            />
          ))}
          {hasDesktopBridge && sshHosts.isPending && sshHosts.data === null ? (
            <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
              <Spinner size="xs" />
              Reading SSH hosts…
            </div>
          ) : null}
        </div>
        {hasDesktopBridge ? (
          <p className="text-muted-foreground text-xs">
            SSH hosts come from ~/.ssh/config. Picking one connects it.
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={openOtherSources}>
          Clone or create new…
        </Button>
        <Button type="button" variant="outline" onClick={closeAddProjectDialog}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

function PickerRow({
  icon,
  title,
  detail,
  disabled = false,
  highlighted = false,
  onClick,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  detail?: React.ReactNode;
  disabled?: boolean;
  highlighted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-highlighted={highlighted || undefined}
      className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm not-last:border-b hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-64 data-highlighted:bg-accent"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        {detail ? <span className="truncate text-muted-foreground text-xs">{detail}</span> : null}
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function FolderStep({
  environment,
  onBack,
}: {
  environment: EnvironmentPresentation | null;
  onBack: () => void;
}) {
  const id = useId();
  const environmentId = environment?.environmentId ?? null;
  const label = environment ? environmentLabel(environment) : "the new machine";
  const connected = canCreateProjectInEnvironment(environment?.connection.phase);
  const [pathOverride, setPathOverride] = useState<string | null>(null);
  const path =
    pathOverride ??
    getAddProjectInitialQuery(environment?.serverConfig?.settings.addProjectBaseDirectory);
  const platform = getEnvironmentBrowsePlatform(environment?.serverConfig?.environment.platform.os);
  const deferredPath = useDeferredValue(path);
  // Like the palette: list the parent folder and filter it by the typed name.
  const browsePath = getFilesystemBrowsePath(deferredPath.trim(), platform);
  const access = useFilesystemReadAccess(connected ? environmentId : null);
  const browse = useEnvironmentQuery(
    connected &&
      environmentId !== null &&
      access.canReadFiles &&
      browsePath.isBrowsing &&
      !isExplicitRelativeProjectPath(deferredPath.trim())
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browsePath.directoryPath },
        })
      : null,
  );
  const listing = browse.data;
  const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(
    listing?.entries ?? [],
    browsePath.filterQuery,
  );
  const isCurrentListing = deferredPath === path;
  const parentPath = getBrowseParentPath(listing?.parentPath ?? browsePath.directoryPath);
  const pathMissing =
    (isFilesystemBrowseError(browse.failure) && browse.failure.pathMissing === true) ||
    (browsePath.filterQuery.length > 0 &&
      listing !== null &&
      exactEntry === null &&
      isHostPath(deferredPath.trim(), platform));
  const rows = [
    ...(parentPath !== null ? [{ key: "..", name: "..", target: parentPath }] : []),
    ...visibleEntries.map((entry) => ({
      key: entry.fullPath,
      name: entry.name,
      target: ensureBrowseDirectoryPath(entry.fullPath),
    })),
  ];
  const [highlight, setHighlight] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const submitting = useAddProjectDialog((state) => state.submitting !== null);
  const canSubmit =
    connected && environmentId !== null && !submitting && isHostPath(path.trim(), platform);
  const addProjectAtPath = useAddProjectAtPath();

  const goTo = (target: string) => {
    setPathOverride(target);
    setHighlight(null);
  };

  const submit = async () => {
    if (!canSubmit || environmentId === null) return;
    const typed = path.trim();
    useAddProjectDialog.setState({ submitting: environmentId });
    const added = await addProjectAtPath({
      environmentId,
      // A loaded listing expands "~", so an existing project at that folder matches.
      rawCwd:
        typed.startsWith("~") && isCurrentListing && listing
          ? `${ensureBrowseDirectoryPath(listing.parentPath)}${browsePath.filterQuery}`
          : typed,
      platform,
      currentProjectCwd: null,
    }).catch(() => false);
    useAddProjectDialog.setState({ submitting: null });
    if (added) closeAddProjectDialog();
  };

  const moveHighlight = (next: number) => {
    setHighlight(next);
    listRef.current?.querySelectorAll("button")[next]?.scrollIntoView({ block: "nearest" });
  };

  const onPathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" && rows.length > 0) {
      event.preventDefault();
      moveHighlight(highlight === null ? 0 : Math.min(highlight + 1, rows.length - 1));
    } else if (event.key === "ArrowUp" && highlight !== null) {
      event.preventDefault();
      if (highlight === 0) setHighlight(null);
      else moveHighlight(highlight - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = highlight === null || event.metaKey || event.ctrlKey ? null : rows[highlight];
      if (row) goTo(row.target);
      else void submit();
    }
  };

  const body = !connected ? (
    <div className="flex items-center gap-2 text-muted-foreground text-sm">
      {environment === null ||
      environment.connection.phase === "connecting" ||
      environment.connection.phase === "reconnecting" ? (
        <Spinner size="md" />
      ) : null}
      {environment ? connectionStatusText(environment.connection) : "Connecting…"}
    </div>
  ) : (
    <>
      <Input
        id={`${id}-path`}
        aria-label={`Folder on ${label}`}
        value={path}
        onChange={(event) => {
          setPathOverride(resolvePastedPath(path, event.target.value));
          setHighlight(null);
        }}
        onKeyDown={onPathKeyDown}
        spellCheck={false}
        autoComplete="off"
        autoFocus
      />
      <div ref={listRef} className="flex h-72 flex-col overflow-y-auto rounded-md border">
        {rows.map((row, index) => (
          <PickerRow
            key={row.key}
            highlighted={index === highlight}
            onClick={() => goTo(row.target)}
            icon={
              row.key === ".." ? (
                <CornerLeftUpIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              )
            }
            title={row.name}
          />
        ))}
        <FolderListStatus
          pending={access.isPending || browse.isPending}
          error={
            access.isPending || access.canReadFiles
              ? pathMissing
                ? null
                : browse.error
              : (access.error ?? "This connection cannot browse folders.")
          }
          empty={
            pathMissing
              ? "Not listed. Add project creates it if it is missing."
              : listing !== null && visibleEntries.length === 0
                ? "No folders inside."
                : null
          }
        />
      </div>
    </>
  );

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add project on {label}</DialogTitle>
        <DialogDescription>Pick a folder. A missing folder is created.</DialogDescription>
      </DialogHeader>
      <DialogPanel>{body}</DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={submitting} onClick={openOtherSources}>
          Clone or create new…
        </Button>
        <Button type="button" variant="outline" disabled={submitting} onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {submitting ? "Adding…" : "Add project"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function FolderListStatus({
  pending,
  error,
  empty,
}: {
  pending: boolean;
  error: string | null;
  empty: string | null;
}) {
  const message = error ?? empty;
  if (!pending && message === null) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-xs",
        error ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {pending ? <Spinner size="xs" /> : null}
      {pending ? "Loading…" : message}
    </div>
  );
}
