import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ProviderSession,
  ServerProvider,
  ServerProviderCodexRateLimitWindow,
} from "@t3tools/contracts";
import { ExternalLinkIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { isElectron } from "../../env";
import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
} from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects, useThread, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import {
  primaryCodexStatusAtom,
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
  codexPermissionsLabel,
  codexProviderStatusLabel,
  codexRateLimitWindowLabel,
  codexRemainingPercent,
  describeCodexRuntimeMode,
  formatStatusTimestamp,
  isCodexSessionStatus,
} from "./StatusPage.logic";

const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

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

function providerPlanLabel(provider: ServerProvider): string | null {
  const planType = provider.codexStatus?.account?.planType;
  switch (planType) {
    case "free":
      return "Free";
    case "go":
      return "Go";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "prolite":
      return "Pro";
    case "team":
      return "Team";
    case "self_serve_business_usage_based":
    case "business":
      return "Business";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "Enterprise";
    case "edu":
      return "Edu";
    case "unknown":
      return "ChatGPT";
    default:
      return null;
  }
}

function providerAccountLabel(provider: ServerProvider): string {
  const email = provider.codexStatus?.account?.email ?? provider.auth.email;
  const plan = providerPlanLabel(provider);
  if (email && plan) return `${email} (${plan})`;
  if (email) return email;
  if (plan) return plan;
  if (provider.auth.status === "unauthenticated") return "Not authenticated";
  return provider.auth.label ?? provider.auth.type ?? "Unknown";
}

function sessionForProvider(session: ProviderSession, provider: ServerProvider): boolean {
  return (
    session.providerInstanceId === provider.instanceId ||
    (session.providerInstanceId === undefined && session.provider === provider.driver)
  );
}

function sandboxLabel(value: NonNullable<ProviderSession["codex"]>["sandbox"]): string {
  switch (value) {
    case "read-only":
      return "Read Only";
    case "workspace-write":
      return "Workspace Write";
    case "danger-full-access":
      return "Full Access";
    default:
      return "Unknown";
  }
}

function StatusRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border/50 py-2.5 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

function formatResetTimestamp(timestamp: number | null | undefined): string | null {
  if (timestamp == null) return null;
  return formatStatusTimestamp(new Date(timestamp * 1000).toISOString());
}

function RateLimitRow({
  window,
  fallbackLabel,
}: {
  readonly window: ServerProviderCodexRateLimitWindow;
  readonly fallbackLabel: string;
}) {
  const remaining = codexRemainingPercent(window.usedPercent);
  const reset = formatResetTimestamp(window.resetsAt);
  const label =
    codexRateLimitWindowLabel(window.windowDurationMins) === "Rate limit"
      ? fallbackLabel
      : codexRateLimitWindowLabel(window.windowDurationMins);

  return (
    <div className="rounded-lg border border-border/60 bg-background/35 px-3 py-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{remaining}% left</span>
      </div>
      <div
        aria-label={`${label}: ${remaining}% left`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={remaining}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${remaining}%` }}
        />
      </div>
      {reset ? <p className="mt-2 text-[11px] text-muted-foreground">Resets {reset}</p> : null}
    </div>
  );
}

function CodexStatusCard({
  provider,
  thread,
  session,
  cwd,
  contextWindow,
}: {
  readonly provider: ServerProvider;
  readonly thread: EnvironmentThreadShell | null;
  readonly session: ProviderSession | undefined;
  readonly cwd: string;
  readonly contextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
}) {
  const runtimeMode = thread?.runtimeMode ?? session?.runtimeMode ?? "full-access";
  const runtimeStatus = describeCodexRuntimeMode(runtimeMode);
  const model = session?.model ?? thread?.modelSelection.model ?? "Unknown";
  const reasoningEffort =
    session?.codex?.reasoningEffort ??
    getModelSelectionStringOptionValue(thread?.modelSelection, "reasoningEffort");
  const modelValue = reasoningEffort
    ? `${model} (reasoning ${reasoningEffort}, summaries auto)`
    : `${model} (summaries auto)`;
  const directory = session?.cwd ?? thread?.worktreePath ?? cwd;
  const permissions = session?.codex?.sandbox
    ? sandboxLabel(session.codex.sandbox)
    : codexPermissionsLabel(runtimeMode);
  const approvalPolicy = session?.codex?.approvalPolicy ?? runtimeStatus.approvalPolicy;
  const instructionSources = session?.codex?.instructionSources ?? [];
  const collaborationMode = thread
    ? thread.interactionMode === "plan"
      ? "Plan"
      : "Default"
    : "Unknown";
  const sessionId = session?.codex?.providerThreadId ?? "No active session";
  const contextValue = contextWindow
    ? contextWindow.maxTokens == null
      ? `${formatContextWindowTokens(contextWindow.usedTokens)} used`
      : `${formatContextWindowTokens(contextWindow.usedTokens)} / ${formatContextWindowTokens(contextWindow.maxTokens)}${contextWindow.usedPercentage === null ? "" : ` (${Math.round(contextWindow.usedPercentage)}%)`}`
    : null;
  const rateLimits = provider.codexStatus?.rateLimits;

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
            <h2 className="truncate text-sm font-medium text-foreground">OpenAI Codex</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {provider.displayName ?? "Codex"} · {codexProviderStatusLabel(provider)}
          </p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {provider.version ? `v${provider.version.replace(/^v/, "")}` : "Version unknown"}
        </span>
      </div>

      <div className="mt-4 rounded-lg border border-border/60 bg-background/25 px-3">
        <dl>
          <StatusRow label="Model">{modelValue}</StatusRow>
          <StatusRow label="Directory">{directory}</StatusRow>
          <StatusRow label="Permissions">
            {permissions} <span className="text-muted-foreground">({approvalPolicy})</span>
          </StatusRow>
          <StatusRow label="AGENTS.md">
            {instructionSources.length > 0 ? (
              <div className="flex flex-col gap-1">
                {instructionSources.map((source) => (
                  <span key={source}>{source}</span>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">Not reported by the active session</span>
            )}
          </StatusRow>
          <StatusRow label="Account">{providerAccountLabel(provider)}</StatusRow>
          <StatusRow label="Collaboration mode">{collaborationMode}</StatusRow>
          <StatusRow label="Session id">
            <span className="font-mono text-xs">{sessionId}</span>
          </StatusRow>
          {contextValue ? <StatusRow label="Context usage">{contextValue}</StatusRow> : null}
        </dl>
      </div>

      {rateLimits?.primary || rateLimits?.secondary ? (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium text-foreground">Rate limits</h3>
            {rateLimits.limitName ? (
              <span className="text-[11px] text-muted-foreground">{rateLimits.limitName}</span>
            ) : null}
          </div>
          {rateLimits.primary ? (
            <RateLimitRow window={rateLimits.primary} fallbackLabel="Primary limit" />
          ) : null}
          {rateLimits.secondary ? (
            <RateLimitRow window={rateLimits.secondary} fallbackLabel="Secondary limit" />
          ) : null}
        </div>
      ) : null}

      {provider.message ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{provider.message}</p>
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
  const codexStatus = useAtomValue(primaryCodexStatusAtom);
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
  const threadById = useMemo(
    () => new Map(codexSessions.map((thread) => [thread.id, thread])),
    [codexSessions],
  );

  type StatusEntry = {
    readonly provider: ServerProvider;
    readonly session: ProviderSession | undefined;
    readonly thread: EnvironmentThreadShell | null;
  };
  const statusEntries = useMemo<ReadonlyArray<StatusEntry>>(() => {
    const sessions = codexStatus?.sessions ?? [];
    const entries: StatusEntry[] = [];
    for (const provider of codexProviders) {
      const providerSessions = sessions.filter((session) => sessionForProvider(session, provider));
      if (providerSessions.length > 0) {
        entries.push(
          ...providerSessions.map((session) => ({
            provider,
            session,
            thread: threadById.get(session.threadId) ?? null,
          })),
        );
        continue;
      }

      const providerThreads = codexSessions.filter(
        (thread) =>
          (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId) ===
          provider.instanceId,
      );
      if (providerThreads.length > 0) {
        entries.push(
          ...providerThreads.map((thread) => ({ provider, session: undefined, thread })),
        );
      } else {
        entries.push({ provider, session: undefined, thread: null });
      }
    }
    return entries;
  }, [codexProviders, codexSessions, codexStatus?.sessions, threadById]);

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
      appAtomRegistry.refresh(
        serverEnvironment.codexStatus({ environmentId: primaryEnvironmentId, input: {} }),
      );
    } finally {
      setIsRefreshing(false);
    }
  }, [codexProviders, isRefreshing, primaryEnvironmentId, refreshProviders]);

  const fallbackCwd = serverConfig?.cwd ?? primaryEnvironment?.serverConfig?.cwd ?? "Unknown";

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
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
          <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-lg font-semibold text-foreground">Codex status</h1>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  The live session details reported by Codex app-server, matching the CLI{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">/status</code> view.
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
                <div className="flex flex-col gap-3">
                  {statusEntries.map(({ provider, session, thread }) => {
                    const project = thread
                      ? projectByKey.get(`${thread.environmentId}:${thread.projectId}`)
                      : undefined;
                    const cwd =
                      session?.cwd ?? thread?.worktreePath ?? project?.workspaceRoot ?? fallbackCwd;
                    return (
                      <CodexStatusCard
                        key={`${provider.instanceId}:${thread?.id ?? session?.threadId ?? "provider"}`}
                        provider={provider}
                        thread={thread}
                        session={session}
                        cwd={cwd}
                        contextWindow={thread?.id === inspectedThread?.id ? contextWindow : null}
                      />
                    );
                  })}
                </div>

                <a
                  className="inline-flex items-center gap-1.5 self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  href={CODEX_USAGE_URL}
                  rel="noreferrer"
                  target="_blank"
                >
                  View up-to-date rate limits and credits
                  <ExternalLinkIcon className="size-3" />
                </a>
              </>
            )}
          </main>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
