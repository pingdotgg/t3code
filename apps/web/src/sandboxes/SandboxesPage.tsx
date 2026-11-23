import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { HostedSandbox, SandboxHost } from "@t3tools/client-runtime/state/sandboxes";
import { EnvironmentId, type AgentctlSandbox, type AgentctlManifestRoot } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  DownloadIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useEnvironmentPresentation } from "../state/presentation";
import { sandboxEnvironment } from "../state/sandboxes";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ManifestFolderInput } from "./ManifestFolderInput";
import { openNewSandboxDialog } from "./NewSandboxDialog";
import {
  canDeleteSandbox,
  canStartSandbox,
  canStopSandbox,
  deleteSandbox,
  runOnHost,
  sandboxStatus,
  sandboxStatusDetail,
  startSandbox,
  stopSandbox,
  type SandboxTone,
} from "./sandboxActions";
import { folderName, pullToast, repositoryBadges, tildePath } from "./manifestFolders";
import { SandboxHostMenu } from "./SandboxHostMenu";
import { useDefaultSandboxHost, useSandboxHostOptions, useSandboxHosts } from "./useSandboxes";

const TONE_VARIANT = {
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
  muted: "outline",
} as const satisfies Record<SandboxTone, string>;

// The most recent threads each Sandbox lists; the sidebar has the rest.
const RECENT_THREADS = 3;

export interface SandboxesSearch {
  /** The host whose Sandboxes the page shows, by its environment id. */
  readonly host?: string;
}

/**
 * Manages one host's agentctl Sandboxes and where new ones come from, opened from the sidebar
 * footer. The header picks the host, so Sandboxes of the same name on two machines stay apart.
 */
export function SandboxesPage() {
  const hosts = useSandboxHosts();
  const search = useSearch({ from: "/sandboxes" });
  const navigate = useNavigate();
  const defaultHost = useDefaultSandboxHost();
  const { isReady, environments } = useEnvironments();
  // A host's list arrives after its connection, so until then there may be one on its way.
  const lookingForHosts =
    !isReady ||
    environments.some(
      (environment) =>
        environment.connection.phase === "connecting" ||
        environment.serverConfig?.agentctlSandboxes === true,
    );
  const host =
    hosts.find((candidate) => candidate.hostEnvironmentId === search.host) ??
    hosts.find((candidate) => candidate.hostEnvironmentId === defaultHost) ??
    null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Sandboxes breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Sandboxes</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            {host !== null ? (
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
                <span className="shrink-0">on</span>
                <SandboxHostMenu
                  value={host.hostEnvironmentId}
                  onChange={(next) => void navigate({ to: "/sandboxes", search: { host: next } })}
                />
              </span>
            ) : null}
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            {host === null ? (
              <p className="text-muted-foreground text-sm">
                {lookingForHosts
                  ? "Looking for Sandboxes…"
                  : "No connected environment manages agentctl Sandboxes."}
              </p>
            ) : (
              <HostSandboxes key={host.hostEnvironmentId} host={host} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** One host's Sandboxes and manifest folders. */
function HostSandboxes({ host }: { readonly host: SandboxHost }) {
  const { snapshot, hostEnvironmentId } = host;
  const option = useSandboxHostOptions().find(
    (candidate) => candidate.hostEnvironmentId === hostEnvironmentId,
  );
  // An offline host's list is as it last reported it, and nothing can act on it until it is back.
  const offline = option?.offline === true;
  if (snapshot.status === "unavailable") {
    return (
      <SettingsSection title="agentctl">
        <SettingsRow
          title="agentctl is not available"
          description={snapshot.error ?? "Install agentctl to run agents in Sandboxes."}
        />
      </SettingsSection>
    );
  }
  if (snapshot.status === "loading") {
    return <p className="text-muted-foreground text-sm">Looking for Sandboxes…</p>;
  }
  return (
    <>
      <SettingsSection
        title="Sandboxes"
        headerAction={
          offline ? null : (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => openNewSandboxDialog(hostEnvironmentId)}
            >
              <PlusIcon className="size-3" />
              New Sandbox
            </Button>
          )
        }
      >
        {offline ? (
          <SettingsRow
            title={`${option?.label ?? "This host"} is offline`}
            description="Its Sandboxes are shown as it last reported them. Reconnect to it to manage them."
          />
        ) : null}
        {snapshot.error !== null ? (
          // The Sandboxes below are as agentctl last reported them.
          <SettingsRow title="agentctl is not responding" description={snapshot.error} />
        ) : null}
        {snapshot.sandboxes.length === 0 ? (
          <SettingsRow
            title="No Sandboxes"
            description="Create one from a manifest, or with agentctl apply."
          />
        ) : (
          snapshot.sandboxes.map((sandbox) => (
            <SandboxRow
              key={sandbox.name}
              sandbox={{ ...sandbox, hostEnvironmentId }}
              homeDirectory={snapshot.homeDirectory}
              hostOffline={offline}
            />
          ))
        )}
      </SettingsSection>
      {/* An offline host can neither list nor change its manifest folders. */}
      {offline ? null : (
        <ManifestFolders
          hostEnvironmentId={hostEnvironmentId}
          homeDirectory={snapshot.homeDirectory}
        />
      )}
    </>
  );
}

/** "4 CPUs · 6Gi memory · 32Gi disk · mediated network", from the manifest. */
function specLine(sandbox: AgentctlSandbox): string | null {
  const parts = [
    sandbox.cpu === null ? null : `${sandbox.cpu} ${sandbox.cpu === "1" ? "CPU" : "CPUs"}`,
    sandbox.memory === null ? null : `${sandbox.memory} memory`,
    sandbox.disk === null ? null : `${sandbox.disk} disk`,
    sandbox.network === null ? null : `${sandbox.network} network`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

function SandboxRow({
  sandbox,
  homeDirectory,
  hostOffline,
}: {
  readonly sandbox: HostedSandbox;
  readonly homeDirectory: string;
  readonly hostOffline: boolean;
}) {
  const environmentId =
    sandbox.environmentId === null ? null : EnvironmentId.make(sandbox.environmentId);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const projects = useProjects();
  const allThreads = useThreadShells();
  const openThread = useNewThreadHandler();
  const threads = sortThreads(
    allThreads.filter(
      (thread) => thread.environmentId === environmentId && thread.archivedAt === null,
    ),
    "updated_at",
  );
  const running = threads.filter((thread) => threadRuntimeIsActive(thread.runtime)).length;
  const project =
    environmentId === null
      ? null
      : (projects.find((candidate) => candidate.environmentId === environmentId) ?? null);
  const status = sandboxStatus(sandbox);
  const detail = sandboxStatusDetail(sandbox);
  // An offline host's notice says why its Sandboxes cannot be reached.
  const connection =
    !hostOffline && sandbox.phase === "ready" && presentation !== null
      ? connectionStatusText(presentation.connection)
      : null;
  const since = sandbox.since === null ? null : formatRelativeTimeLabel(sandbox.since);
  const threadSummary =
    threads.length === 0
      ? "No threads"
      : `${threads.length} ${threads.length === 1 ? "thread" : "threads"}${running > 0 ? `, ${running} running` : ""}`;

  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{sandbox.name}</span>
          <Badge variant={TONE_VARIANT[status.tone]} size="sm">
            {status.label}
          </Badge>
          {sandbox.variant ? (
            <span className="text-muted-foreground text-xs">{sandbox.variant}</span>
          ) : null}
        </span>
      }
      description={
        <span className="flex min-w-0 flex-col gap-0.5">
          {[detail, connection, since ? `Changed ${since}` : null]
            .filter((part) => part !== null && part !== "")
            .join(" · ") || null}
          {specLine(sandbox) ? <span>{specLine(sandbox)}</span> : null}
          {sandbox.manifestPath ? (
            <span className="truncate font-mono text-xs">
              {tildePath(sandbox.manifestPath, homeDirectory)}
            </span>
          ) : null}
          <span>{threadSummary}</span>
          {threads.slice(0, RECENT_THREADS).map((thread) => (
            <Link
              key={thread.id}
              to="/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
              className="truncate text-foreground hover:underline"
            >
              {thread.title}
            </Link>
          ))}
        </span>
      }
      control={
        hostOffline ? null : (
          <div className="flex shrink-0 items-center gap-1">
            {project !== null && sandbox.phase === "ready" ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void openThread(scopeProjectRef(project.environmentId, project.id))}
              >
                New thread
              </Button>
            ) : null}
            {canStartSandbox(sandbox) ? (
              <Button size="xs" variant="outline" onClick={() => void startSandbox(sandbox)}>
                Start
              </Button>
            ) : null}
            {canStopSandbox(sandbox) ? (
              <Button size="xs" variant="ghost-muted" onClick={() => void stopSandbox(sandbox)}>
                Stop
              </Button>
            ) : null}
            {canDeleteSandbox(sandbox) ? (
              <Button
                size="xs"
                variant="ghost-destructive"
                onClick={() => void deleteSandbox(sandbox)}
              >
                Delete
              </Button>
            ) : null}
          </div>
        )
      }
    />
  );
}

/** Where "New Sandbox" looks for manifests, and whether their repositories are current. */
function ManifestFolders({
  hostEnvironmentId,
  homeDirectory,
}: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly homeDirectory: string;
}) {
  const [roots, setRoots] = useState<ReadonlyArray<AgentctlManifestRoot> | null>(null);
  // The folders being pulled, so their rows show it and nothing pulls twice.
  const [pulling, setPulling] = useState<ReadonlyArray<string>>([]);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const hostConfig = useAtomValue(serverEnvironment.configValueAtom(hostEnvironmentId));
  const canOpen = hostConfig?.availableEditors.includes("file-manager") === true;
  // Bumped by every read, so a slow fetch cannot overwrite a newer add or remove.
  const generation = useRef(0);
  const readRoots = (command: typeof sandboxEnvironment.listManifestRoots) =>
    runOnHost(command, hostEnvironmentId, {}).then((outcome) =>
      "error" in outcome ? null : outcome.value,
    );
  const load = (read: Promise<ReadonlyArray<AgentctlManifestRoot> | null>) => {
    const current = ++generation.current;
    return read.then((next) => {
      if (next !== null && generation.current === current) setRoots(next);
    });
  };

  const loadInitial = useEffectEvent(() => {
    // Local state first, then again once each repository has fetched; the fetch
    // is ignored if the list changed meanwhile or the page closed.
    void readRoots(sandboxEnvironment.listManifestRoots).then((next) =>
      setRoots((current) => current ?? next),
    );
    const current = ++generation.current;
    void readRoots(sandboxEnvironment.refreshManifestRoots).then((next) => {
      if (next !== null && generation.current === current) setRoots(next);
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- host RPC: reads manifest folders while mounted, and drops a fetch that ends after unmount
  useEffect(() => {
    loadInitial();
    return () => {
      generation.current += 1;
    };
  }, []);

  if (roots === null) return null;
  const addRoot = async (folder: string) => {
    const added = await runOnHost(sandboxEnvironment.addManifestRoot, hostEnvironmentId, {
      folder,
    });
    if ("error" in added) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add folder",
          description: added.error,
        }),
      );
    }
    await load(readRoots(sandboxEnvironment.listManifestRoots));
  };
  const removeRoot = async (folder: string) => {
    await runOnHost(sandboxEnvironment.removeManifestRoot, hostEnvironmentId, { folder });
    await load(readRoots(sandboxEnvironment.listManifestRoots));
  };
  const pullRoots = async (folders: ReadonlyArray<string>) => {
    if (pulling.length > 0) return;
    setPulling(folders);
    const pulled = await runOnHost(sandboxEnvironment.pullManifestRoots, hostEnvironmentId, {
      folders,
    });
    toastManager.add(
      stackedThreadToast(
        "error" in pulled
          ? { type: "error", title: "Could not pull repositories", description: pulled.error }
          : pullToast(pulled.value),
      ),
    );
    await load(readRoots(sandboxEnvironment.listManifestRoots));
    setPulling([]);
  };
  // The host opens it, in its own file manager.
  const openRoot = async (folder: string) => {
    const result = await openInEditor({
      environmentId: hostEnvironmentId,
      input: { cwd: folder, editor: "file-manager" },
    });
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Could not open folder", description: folder }),
      );
    }
  };
  const pullable = roots
    .filter((root) => root.repositories.length > 0)
    .map((root) => root.directory);

  return (
    <SettingsSection
      title="Manifest folders"
      headerAction={
        <span className="flex items-center gap-1">
          {pullable.length > 1 ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={pulling.length > 0}
              onClick={() => void pullRoots(pullable)}
            >
              <DownloadIcon className="size-3" />
              {pulling.length > 1 ? "Pulling…" : "Pull all"}
            </Button>
          ) : null}
          <ManifestFolderInput hostEnvironmentId={hostEnvironmentId} onAdd={addRoot} />
        </span>
      }
    >
      {roots.length === 0 ? (
        <SettingsRow
          title="No folders yet"
          description="New Sandbox finds every agent.yaml and agent.<variant>.yaml in these folders."
        />
      ) : (
        roots.map((root) => (
          <ManifestFolderRow
            key={root.directory}
            root={root}
            homeDirectory={homeDirectory}
            pulling={pulling.includes(root.directory)}
            busy={pulling.length > 0}
            onPull={() => void pullRoots([root.directory])}
            onOpen={canOpen ? () => void openRoot(root.directory) : null}
            onRemove={() => void removeRoot(root.directory)}
          />
        ))
      )}
    </SettingsSection>
  );
}

function ManifestFolderRow({
  root,
  homeDirectory,
  pulling,
  busy,
  onPull,
  onOpen,
  onRemove,
}: {
  root: AgentctlManifestRoot;
  homeDirectory: string;
  pulling: boolean;
  busy: boolean;
  onPull: () => void;
  /** Null when the host has no file manager to open it in. */
  onOpen: (() => void) | null;
  onRemove: () => void;
}) {
  const path = tildePath(root.directory, homeDirectory);
  const Icon = root.repositories.length > 0 ? FolderGit2Icon : FolderIcon;
  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{folderName(root.directory)}</span>
          {!root.exists ? (
            <Badge variant="error" size="sm">
              Not found
            </Badge>
          ) : root.manifests === 0 ? (
            <Badge variant="warning" size="sm">
              No manifests
            </Badge>
          ) : (
            <span className="shrink-0 text-muted-foreground text-xs">
              {root.manifests} {root.manifests === 1 ? "manifest" : "manifests"}
            </span>
          )}
        </span>
      }
      description={
        <span className="flex min-w-0 flex-col gap-1">
          <span className="break-all font-mono text-xs">{path}</span>
          {root.repositories.map((repository) => (
            <span key={repository.path} className="flex flex-wrap items-center gap-1.5 text-xs">
              {/* Name the checkout when it is not the folder itself. */}
              {repository.path !== root.directory && root.repositories.length > 1 ? (
                <span className="font-medium text-foreground">{folderName(repository.path)}</span>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <GitBranchIcon className="size-3" />
                {repository.branch ?? "detached"}
              </span>
              {repositoryBadges(repository).map((badge) => (
                <Badge
                  key={badge.label}
                  variant={TONE_VARIANT[badge.tone]}
                  size="sm"
                  title={badge.title}
                >
                  {badge.label}
                </Badge>
              ))}
            </span>
          ))}
        </span>
      }
      control={
        <div className="flex shrink-0 items-center gap-1">
          {root.repositories.length > 0 ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Pull repositories in ${path}`}
              disabled={busy}
              onClick={onPull}
            >
              <DownloadIcon className="size-3" />
              {pulling ? "Pulling…" : "Pull"}
            </Button>
          ) : null}
          {root.exists && onOpen !== null ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Open ${path}`}
              title="Open folder"
              onClick={onOpen}
            >
              <FolderOpenIcon className="size-3" />
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Remove ${path}`}
            title="Remove folder"
            disabled={pulling}
            onClick={onRemove}
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      }
    />
  );
}
