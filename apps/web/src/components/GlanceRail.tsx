/**
 * Desktop-only blue edge rail for quick project/thread glance information.
 * The hover drawer keeps lightweight status readouts and navigation actions
 * close at hand without becoming another persistent sidebar.
 *
 * @module GlanceRail
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  ActivityIcon,
  GaugeIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  ListFilterIcon,
  MessagesSquareIcon,
  PlusIcon,
  Settings2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { useComposerDraftStore } from "../composerDraftStore";
import { useActiveProjectTarget } from "../hooks/useActiveProjectTarget";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { cn } from "../lib/utils";
import { useProject, useThreadShell, useThreadShells } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  resolveGlanceRailUsage,
  resolveGlanceRailGitPosition,
  summarizeGlanceRail,
  type GlanceRailUsage,
  type GlanceRailGitPosition,
} from "./glanceRailStats";
import { readPullRequestListPreferences } from "./pullRequest/pullRequestListPreferences";

type GlanceRailStatScope = "all" | "project";

const DOCK_ITEM_CLASS =
  "group/dock-item relative flex min-h-14 w-full origin-right transform-gpu items-center gap-3 rounded-xl px-2.5 py-2 text-right outline-hidden ring-ring transition-transform duration-150 ease-out hover:z-10 hover:-translate-x-1 hover:scale-[1.02] focus-visible:z-10 focus-visible:-translate-x-1 focus-visible:scale-[1.02] focus-visible:ring-2 motion-reduce:transform-none motion-reduce:transition-none motion-reduce:hover:translate-x-0 motion-reduce:hover:scale-100 motion-reduce:focus-visible:translate-x-0 motion-reduce:focus-visible:scale-100";

function DockItemContent({
  detail,
  icon,
  title,
  value,
  valueTone,
}: {
  readonly detail: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly value?: number | string;
  readonly valueTone?: string | undefined;
}) {
  return (
    <>
      <span className="min-w-0 flex-1 text-right">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
            {title}
          </span>
          {value === undefined ? null : (
            <span
              className={cn(
                "shrink-0 text-xs font-semibold tabular-nums text-sidebar-foreground",
                valueTone,
              )}
            >
              {value}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-sidebar-muted-foreground">
          {detail}
        </span>
      </span>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-sidebar-border/70 bg-sidebar text-sidebar-muted-foreground shadow-xs/5 transition-transform duration-150 ease-out group-hover/dock-item:scale-110 group-focus-visible/dock-item:scale-110 motion-reduce:transition-none motion-reduce:group-hover/dock-item:scale-100 motion-reduce:group-focus-visible/dock-item:scale-100">
        {icon}
      </span>
    </>
  );
}

function DockReadout({
  detail,
  icon,
  title,
  value,
  valueTone,
}: {
  readonly detail: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly value: number | string;
  readonly valueTone?: string;
}) {
  return (
    <div className={cn(DOCK_ITEM_CLASS, "cursor-default")}>
      <DockItemContent
        detail={detail}
        icon={icon}
        title={title}
        value={value}
        valueTone={valueTone}
      />
    </div>
  );
}

function UsageRemainingReadout({ usage }: { readonly usage: GlanceRailUsage }) {
  const accountAndWindow = `${usage.accountLabel} · ${usage.windowLabel}`;
  const summary = `${accountAndWindow}: ${usage.remainingPercent}% remaining`;

  return (
    <div
      aria-label={summary}
      className={cn(DOCK_ITEM_CLASS, "cursor-default")}
      data-glance-rail-usage=""
    >
      <span className="min-w-0 flex-1 text-right">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
            Usage remaining
          </span>
          <span className="shrink-0 text-xs font-semibold tabular-nums text-sidebar-foreground">
            {usage.remainingPercent}%
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-sidebar-muted-foreground">
          {accountAndWindow}
        </span>
        <span
          aria-label={summary}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={usage.remainingPercent}
          className="relative mt-1.5 block h-1.5 overflow-hidden rounded-full bg-sidebar"
          role="progressbar"
        >
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${usage.remainingPercent}%` }}
          />
        </span>
      </span>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-sidebar-border/70 bg-sidebar text-sidebar-muted-foreground shadow-xs/5 transition-transform duration-150 ease-out group-hover/dock-item:scale-110 motion-reduce:transition-none motion-reduce:group-hover/dock-item:scale-100">
        <GaugeIcon aria-hidden="true" className="size-5" />
      </span>
    </div>
  );
}

const GIT_POSITION_TONE = {
  synced: "text-success-foreground",
  ahead: "text-info-foreground",
  behind: "text-warning-foreground",
  diverged: "text-warning-foreground",
  "not-repository": "text-sidebar-muted-foreground",
} as const satisfies Record<GlanceRailGitPosition["state"], string>;

export function GlanceRail() {
  const [statScope, setStatScope] = useState<GlanceRailStatScope>("project");
  const activeProjectTarget = useActiveProjectTarget();
  const handleNewThread = useNewThreadHandler();
  const threads = useThreadShells();
  const activeThreadShell = useThreadShell(activeProjectTarget?.threadRef ?? null);
  const activeProject = useProject(
    activeProjectTarget === null
      ? null
      : scopeProjectRef(activeProjectTarget.environmentId, activeProjectTarget.projectId),
  );
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const activeServerConfig =
    activeProjectTarget === null
      ? null
      : (presentations.get(activeProjectTarget.environmentId)?.serverConfig ?? null);
  const activeProjectDefaultModelSelection =
    activeServerConfig === null || activeProject === null
      ? null
      : resolveProjectSettings(activeServerConfig.settings, activeProject.id, activeProject)
          .settings.defaultModelSelection;
  const composerActiveProvider = useComposerDraftStore((store) =>
    activeProjectTarget === null
      ? null
      : (store.getComposerDraft(activeProjectTarget.threadRef)?.activeProvider ?? null),
  );
  const providerForInstance = (instanceId: string | null | undefined) =>
    activeServerConfig?.providers.find((provider) => provider.instanceId === instanceId) ?? null;
  const activeProvider =
    providerForInstance(composerActiveProvider) ??
    providerForInstance(activeThreadShell?.session?.providerInstanceId) ??
    providerForInstance(activeThreadShell?.modelSelection.instanceId) ??
    providerForInstance(activeProjectDefaultModelSelection?.instanceId);
  const usageLimits = activeProvider?.usageLimits;
  const usage = resolveGlanceRailUsage(
    activeProvider === null || usageLimits === undefined
      ? null
      : {
          accountLabel: activeProvider.displayName?.trim() || String(activeProvider.driver),
          unavailable: usageLimits.unavailable !== undefined,
          windows: usageLimits.windows,
        },
  );
  const effectiveStatScope =
    statScope === "project" && activeProjectTarget !== null ? "project" : "all";
  const filteredThreads =
    effectiveStatScope === "project" && activeProjectTarget !== null
      ? threads.filter(
          (thread) =>
            thread.environmentId === activeProjectTarget.environmentId &&
            thread.projectId === activeProjectTarget.projectId,
        )
      : threads;
  const stats = summarizeGlanceRail(filteredThreads);
  const gitStatusQuery = useEnvironmentQuery(
    activeProjectTarget === null
      ? null
      : vcsEnvironment.status({
          environmentId: activeProjectTarget.environmentId,
          input: { cwd: activeProjectTarget.cwd },
        }),
  );
  const gitPosition = gitStatusQuery.data
    ? resolveGlanceRailGitPosition(gitStatusQuery.data)
    : null;
  const gitPositionState =
    gitPosition?.state ?? (gitStatusQuery.isPending ? "loading" : "unavailable");
  const gitPositionLabel =
    gitPosition?.label ??
    (activeProjectTarget === null
      ? "Open a thread"
      : gitStatusQuery.isPending
        ? "Checking"
        : "Unavailable");
  const gitPositionTone =
    gitPositionState === "loading" || gitPositionState === "unavailable"
      ? "text-sidebar-muted-foreground"
      : GIT_POSITION_TONE[gitPositionState];
  const gitContext =
    activeProjectTarget === null
      ? "No active project"
      : [
          activeProjectTarget.projectName,
          gitStatusQuery.data?.refName,
          gitStatusQuery.data?.hasWorkingTreeChanges === true ? "Local changes" : null,
        ]
          .filter((part): part is string => part !== null && part !== undefined)
          .join(" · ");

  return (
    <aside
      aria-label="Quick glance"
      className="group/glance pointer-coarse:hidden fixed right-0 top-1/2 z-40 hidden h-24 w-3 -translate-y-1/2 md:block"
      data-app-sidebar=""
      data-glance-rail=""
    >
      <div className="pointer-events-none absolute right-0 top-1/2 w-[min(18rem,calc(100vw-1rem))] -translate-y-1/2">
        <div className="pointer-events-auto relative isolate translate-x-[calc(100%-0.25rem)] transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-linear-to-l before:from-black/55 before:via-black/25 before:to-transparent before:opacity-0 before:transition-opacity before:duration-200 before:content-[''] group-focus-within/glance:translate-x-0 group-focus-within/glance:before:opacity-100 group-hover/glance:translate-x-0 group-hover/glance:before:opacity-100 motion-reduce:transition-none motion-reduce:before:transition-none">
          <div className="max-h-[calc(100dvh-1.5rem)] overflow-y-auto p-2.5 text-sidebar-foreground">
            <div className="space-y-1.5 opacity-0 transition-opacity duration-150 group-focus-within/glance:opacity-100 group-hover/glance:opacity-100 motion-reduce:transition-none">
              <DockReadout
                detail={gitContext}
                icon={
                  <GitBranchIcon aria-hidden="true" className={cn("size-5", gitPositionTone)} />
                }
                title="Main"
                value={gitPositionLabel}
                valueTone={gitPositionTone}
              />

              <div aria-label="Stats scope" className={cn(DOCK_ITEM_CLASS, "cursor-default")}>
                <span className="min-w-0 flex-1 text-right">
                  <span className="block truncate text-sm font-medium">Stats scope</span>
                  <span
                    className="mt-1 ml-auto flex w-fit rounded-md bg-sidebar p-0.5"
                    role="group"
                  >
                    <button
                      aria-pressed={effectiveStatScope === "all"}
                      className={cn(
                        "min-h-7 cursor-pointer rounded-sm px-2 text-xs text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2",
                        effectiveStatScope === "all" &&
                          "bg-sidebar-row-selected text-sidebar-foreground shadow-xs/5",
                      )}
                      onClick={() => setStatScope("all")}
                      type="button"
                    >
                      All
                    </button>
                    <button
                      aria-pressed={effectiveStatScope === "project"}
                      className={cn(
                        "min-h-7 cursor-pointer rounded-sm px-2 text-xs text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
                        effectiveStatScope === "project" &&
                          "bg-sidebar-row-selected text-sidebar-foreground shadow-xs/5",
                      )}
                      disabled={activeProjectTarget === null}
                      onClick={() => setStatScope("project")}
                      type="button"
                    >
                      <span
                        className="block max-w-40 truncate"
                        title={activeProjectTarget?.projectName}
                      >
                        {activeProjectTarget?.projectName ?? "No project"}
                      </span>
                    </button>
                  </span>
                </span>
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-sidebar-border/70 bg-sidebar text-sidebar-muted-foreground shadow-xs/5 transition-transform duration-150 ease-out group-hover/dock-item:scale-110 motion-reduce:transition-none motion-reduce:group-hover/dock-item:scale-100">
                  <ListFilterIcon aria-hidden="true" className="size-5" />
                </span>
              </div>

              <DockReadout
                detail={stats.running === 1 ? "Agent active now" : "Agents active now"}
                icon={<ActivityIcon aria-hidden="true" className="size-5 text-info-foreground" />}
                title="Running"
                value={stats.running}
                valueTone="text-info-foreground"
              />
              <DockReadout
                detail={
                  stats.needsAttention === 1 ? "Thread waiting for you" : "Threads waiting for you"
                }
                icon={
                  <TriangleAlertIcon
                    aria-hidden="true"
                    className={cn(
                      "size-5",
                      stats.needsAttention > 0
                        ? "text-warning-foreground"
                        : "text-sidebar-muted-foreground",
                    )}
                  />
                }
                title="Needs you"
                value={stats.needsAttention}
                valueTone={
                  stats.needsAttention > 0
                    ? "text-warning-foreground"
                    : "text-sidebar-muted-foreground"
                }
              />
              <DockReadout
                detail={
                  effectiveStatScope === "project" ? "In this project" : "Across all projects"
                }
                icon={<MessagesSquareIcon aria-hidden="true" className="size-5" />}
                title="Threads"
                value={stats.threads}
              />
              {usage ? <UsageRemainingReadout usage={usage} /> : null}

              <div aria-hidden="true" className="mx-2 h-px bg-sidebar-border/70" />

              <button
                className={cn(DOCK_ITEM_CLASS, "cursor-pointer")}
                onClick={() => {
                  if (activeProjectTarget === null) {
                    openCommandPalette({ open: "new-thread-in" });
                    return;
                  }
                  void handleNewThread(
                    scopeProjectRef(
                      activeProjectTarget.environmentId,
                      activeProjectTarget.projectId,
                    ),
                  );
                }}
                type="button"
              >
                <DockItemContent
                  detail={
                    activeProjectTarget === null
                      ? "Choose a project"
                      : `Start in ${activeProjectTarget.projectName}`
                  }
                  icon={<PlusIcon aria-hidden="true" className="size-5" />}
                  title="New thread"
                />
              </button>
              <Link
                className={cn(DOCK_ITEM_CLASS, "cursor-pointer")}
                search={readPullRequestListPreferences()}
                to="/pull-requests"
              >
                <DockItemContent
                  detail="Review and merge changes"
                  icon={<GitPullRequestIcon aria-hidden="true" className="size-5" />}
                  title="Pull requests"
                />
              </Link>
              <Link className={cn(DOCK_ITEM_CLASS, "cursor-pointer")} to="/settings">
                <DockItemContent
                  detail="Customize T3 Code"
                  icon={<Settings2Icon aria-hidden="true" className="size-5" />}
                  title="Settings"
                />
              </Link>
            </div>
          </div>
        </div>

        <span
          aria-hidden="true"
          className="pointer-events-auto absolute right-0 top-1/2 h-24 w-1 -translate-y-1/2 rounded-l-full bg-primary/75 shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_35%,transparent)] transition-[height,top,transform] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-focus-within/glance:top-0 group-focus-within/glance:h-full group-focus-within/glance:translate-y-0 group-hover/glance:top-0 group-hover/glance:h-full group-hover/glance:translate-y-0 motion-reduce:transition-none"
        />
      </div>
    </aside>
  );
}
