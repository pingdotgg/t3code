import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { ServerProvider } from "@t3tools/contracts";

import { isElectron } from "../../env";
import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
} from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { useProjects, useThread, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import {
  primaryServerConfigAtom,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  codexProviderStatusLabel,
  describeCodexRuntimeMode,
  formatStatusTimestamp,
  isCodexSessionStatus,
} from "./StatusPage.logic";

function isCodexThread(
  thread: EnvironmentThreadShell,
  codexInstanceIds: ReadonlySet<string>,
): boolean {
  return (
    thread.session?.providerName === "codex" ||
    codexInstanceIds.has(thread.session?.providerInstanceId ?? thread.modelSelection.instanceId)
  );
}

function sortSessions(left: EnvironmentThreadShell, right: EnvironmentThreadShell): number {
  const leftUpdatedAt = left.session?.updatedAt ?? left.updatedAt;
  const rightUpdatedAt = right.session?.updatedAt ?? right.updatedAt;
  return rightUpdatedAt.localeCompare(leftUpdatedAt);
}

function providerAuthLabel(provider: ServerProvider): string {
  if (provider.auth.status === "authenticated") {
    return provider.auth.label ?? provider.auth.type ?? "Authenticated";
  }
  if (provider.auth.status === "unauthenticated") return "Not authenticated";
  return "Unknown";
}

function StatusMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/70 bg-background/35 px-3 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ProviderStatusCard({ provider }: { readonly provider: ServerProvider }) {
  return (
    <Card className="gap-0 rounded-xl border-border/70 bg-card/35 p-4 shadow-none">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                "size-2 rounded-full",
                provider.status === "ready"
                  ? "bg-success"
                  : provider.status === "error"
                    ? "bg-destructive"
                    : "bg-warning",
              )}
            />
            <h2 className="truncate text-sm font-medium text-foreground">
              {provider.displayName ?? "Codex"}
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{codexProviderStatusLabel(provider)}</p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {provider.version ? `v${provider.version.replace(/^v/, "")}` : "Version unknown"}
        </span>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
        <StatusMetric label="Authentication" value={providerAuthLabel(provider)} />
        <StatusMetric label="Checked" value={formatStatusTimestamp(provider.checkedAt)} />
      </dl>

      {provider.message ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{provider.message}</p>
      ) : null}
    </Card>
  );
}

function SessionStatusCard({
  thread,
  cwd,
  contextWindow,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly cwd: string;
  readonly contextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
}) {
  const runtimeMode = thread.session?.runtimeMode ?? thread.runtimeMode;
  const runtimeStatus = describeCodexRuntimeMode(runtimeMode);
  const sessionStatus = thread.session?.status ?? "idle";
  const contextValue = contextWindow
    ? contextWindow.maxTokens == null
      ? `${formatContextWindowTokens(contextWindow.usedTokens)} used`
      : `${formatContextWindowTokens(contextWindow.usedTokens)} / ${formatContextWindowTokens(contextWindow.maxTokens)}${contextWindow.usedPercentage === null ? "" : ` (${Math.round(contextWindow.usedPercentage)}%)`}`
    : "Not available yet";

  return (
    <Card className="gap-0 rounded-xl border-border/70 bg-card/35 p-4 shadow-none">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 shrink-0 text-muted-foreground" />
            <h2 className="truncate text-sm font-medium text-foreground">{thread.title}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Codex session · {sessionStatus}</p>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {runtimeMode}
        </span>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <StatusMetric label="Model" value={thread.modelSelection.model} />
        <StatusMetric label="Approval policy" value={runtimeStatus.approvalPolicy} />
        <StatusMetric label="Sandbox" value={runtimeStatus.sandbox} />
        <StatusMetric label="Writable roots" value={runtimeStatus.writableRoots} />
        <StatusMetric label="Working directory" value={cwd} />
        <StatusMetric label="Context window" value={contextValue} />
      </dl>

      {thread.session?.lastError ? (
        <p className="mt-3 text-xs leading-relaxed text-destructive">{thread.session.lastError}</p>
      ) : null}
    </Card>
  );
}

function StatusEmptyState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <Empty className="min-h-64 rounded-xl border border-dashed border-border/70 bg-card/20 p-8">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldCheckIcon />
        </EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function StatusPage() {
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects();
  const threadShells = useThreadShells();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const codexProviders = useMemo(
    () => providers.filter((provider) => provider.driver === "codex"),
    [providers],
  );
  const codexInstanceIds = useMemo(
    () => new Set(codexProviders.map((provider) => provider.instanceId)),
    [codexProviders],
  );
  const codexSessions = useMemo(
    () =>
      threadShells
        .filter(
          (thread) =>
            thread.environmentId === primaryEnvironmentId &&
            thread.session !== null &&
            isCodexSessionStatus(thread.session.status) &&
            isCodexThread(thread, codexInstanceIds),
        )
        .toSorted(sortSessions),
    [codexInstanceIds, primaryEnvironmentId, threadShells],
  );
  const inspectedThread = codexSessions[0] ?? null;
  const inspectedThreadRef = useMemo(
    () =>
      inspectedThread ? scopeThreadRef(inspectedThread.environmentId, inspectedThread.id) : null,
    [inspectedThread],
  );
  const inspectedThreadDetail = useThread(inspectedThreadRef);
  const contextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(inspectedThreadDetail?.activities ?? []),
    [inspectedThreadDetail?.activities],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );

  const refresh = useCallback(async () => {
    if (!primaryEnvironmentId || isRefreshing) return;
    setIsRefreshing(true);
    try {
      for (const provider of codexProviders) {
        await refreshProviders({
          environmentId: primaryEnvironmentId,
          input: { instanceId: provider.instanceId },
        });
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [codexProviders, isRefreshing, primaryEnvironmentId, refreshProviders]);

  const fallbackCwd = serverConfig?.cwd ?? primaryEnvironment?.serverConfig?.cwd ?? "Unknown";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron ? (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Status breadcrumb">
              <WorkspaceBreadcrumbItem current>Status</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        ) : (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Status breadcrumb">
              <WorkspaceBreadcrumbItem current>Status</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-lg font-semibold text-foreground">Codex status</h1>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  The current Codex provider and session settings, equivalent to the information
                  shown by <code className="rounded bg-muted px-1 py-0.5 text-xs">/status</code>.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={isRefreshing || codexProviders.length === 0}
                onClick={() => void refresh()}
              >
                <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
                Refresh
              </Button>
            </div>

            {codexProviders.length === 0 ? (
              <StatusEmptyState
                title="Codex is not configured"
                description="Add or enable the Codex provider in Settings to inspect its status here."
              />
            ) : (
              <>
                <section className="flex flex-col gap-3" aria-labelledby="codex-provider-heading">
                  <div className="flex items-center justify-between gap-3">
                    <h2 id="codex-provider-heading" className="text-sm font-medium text-foreground">
                      Provider
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {codexProviders.length === 1
                        ? "Codex installation and authentication"
                        : `${codexProviders.length} Codex instances`}
                    </span>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {codexProviders.map((provider) => (
                      <ProviderStatusCard key={provider.instanceId} provider={provider} />
                    ))}
                  </div>
                </section>

                <section className="flex flex-col gap-3" aria-labelledby="codex-sessions-heading">
                  <div className="flex items-center justify-between gap-3">
                    <h2 id="codex-sessions-heading" className="text-sm font-medium text-foreground">
                      Sessions
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {codexSessions.length === 0
                        ? "No active sessions"
                        : `${codexSessions.length} active session${codexSessions.length === 1 ? "" : "s"}`}
                    </span>
                  </div>

                  {codexSessions.length === 0 ? (
                    <StatusEmptyState
                      title="No active Codex session"
                      description="Start a Codex conversation to see its model, permissions, workspace, and context window here."
                    />
                  ) : (
                    <div className="flex flex-col gap-3">
                      {codexSessions.map((thread, index) => {
                        const project = projectByKey.get(
                          `${thread.environmentId}:${thread.projectId}`,
                        );
                        const cwd = thread.worktreePath ?? project?.workspaceRoot ?? fallbackCwd;
                        return (
                          <SessionStatusCard
                            key={thread.id}
                            thread={thread}
                            cwd={cwd}
                            contextWindow={index === 0 ? contextWindow : null}
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              </>
            )}
          </main>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
