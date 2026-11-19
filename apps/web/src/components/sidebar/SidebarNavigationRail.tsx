import { useGT } from "gt-react";
import {
  ChartNoAxesColumnIcon,
  CircleDotDashedIcon,
  MessagesSquareIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { selectThreadQuickAccess } from "@t3tools/client-runtime/state/thread-quick-access";

import { openCommandPalette } from "../../commandPaletteBus";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  useIssuesSupported,
  usePrimaryEnvironmentId,
  usePullRequestsSupported,
} from "../../state/environments";
import { useQuietThreadShells } from "../../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { IssueGlyph } from "../issue/issuePresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";

function RailButton({
  active = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
            size="icon-sm"
            variant={active ? "secondary" : "ghost-muted"}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function RailSection({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex w-full flex-col items-center gap-1 border-t border-sidebar-border/70 py-2">
      {children}
    </div>
  );
}

function initials(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => [...word][0] ?? "")
    .join("")
    .toLocaleUpperCase();
}

export function SidebarNavigationRail({
  drawerOpen,
  sidebarOpen,
  onEnvironment,
  onSearch,
  onThreads,
}: {
  drawerOpen: boolean;
  sidebarOpen: boolean;
  onEnvironment: () => void;
  onSearch: () => void;
  onThreads: () => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const router = useRouter();
  const navigateToMainApp = useNavigateToMainApp();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeThreadRef = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const environments = useEnvironmentIdentities();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scopedEnvironmentIds = useUiStateStore((store) => store.sidebarEnvironmentScopeIds);
  const threads = useQuietThreadShells();
  const quickThreads = selectThreadQuickAccess(threads);
  const scopedEnvironmentId =
    scopedEnvironmentIds.length === 1
      ? (environments.find((candidate) => candidate.environmentId === scopedEnvironmentIds[0])
          ?.environmentId ?? null)
      : null;
  const environmentId =
    scopedEnvironmentId ??
    routeThreadRef?.environmentId ??
    primaryEnvironmentId ??
    environments[0]?.environmentId ??
    null;
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const environmentLabel = environment?.label ?? gt("All environments");
  const environmentOnline =
    environmentId !== null && connectedEnvironmentIds.includes(environmentId);
  const utilityPageOpen = isSidebarUtilityPage(pathname);
  const threadsActive =
    drawerOpen || (!utilityPageOpen && pathname !== "/usage" && !pathname.startsWith("/settings"));

  const openThreads = () => {
    if (utilityPageOpen) {
      void navigateToMainApp();
      return;
    }
    onThreads();
  };

  return (
    <nav
      aria-label={gt("Threads")}
      className="fixed inset-y-0 left-0 z-20 hidden w-(--sidebar-width-icon) flex-col items-center border-r border-sidebar-border bg-sidebar surface-grain text-sidebar-foreground md:flex"
      data-sidebar-navigation-rail=""
    >
      {/* SidebarControl owns this slot so the original menu/sidebar action remains unchanged. */}
      <div className="h-[var(--workspace-topbar-height)] shrink-0" />
      <RailSection>
        <RailButton
          active={scopedEnvironmentIds.length > 0}
          icon={
            <span className="relative grid size-6 place-items-center rounded-md bg-emerald-500/10 text-[9px] font-semibold text-emerald-700 dark:text-emerald-300">
              {initials(environmentLabel) || "ENV"}
              <span
                aria-hidden
                className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-sidebar ${environmentOnline ? "bg-emerald-500" : "bg-muted-foreground/45"}`}
              />
            </span>
          }
          label={`${gt("Environment")}: ${environmentLabel}`}
          onClick={onEnvironment}
        />
      </RailSection>
      <RailSection>
        {!sidebarOpen && !drawerOpen
          ? quickThreads.map(({ thread, working }) => {
              const ref = scopeThreadRef(thread.environmentId, thread.id);
              const active =
                routeThreadRef !== null && scopedThreadKey(routeThreadRef) === scopedThreadKey(ref);
              const label = working ? `${gt("Working")}: ${thread.title}` : thread.title;
              return (
                <RailButton
                  active={active}
                  icon={
                    working ? (
                      <span className="relative grid size-6 place-items-center">
                        <CircleDotDashedIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
                        <span className="absolute right-0 top-0 size-1.5 rounded-full bg-emerald-500" />
                      </span>
                    ) : (
                      <span className="grid size-6 place-items-center rounded-full bg-foreground/[0.07] text-[9px] font-medium text-muted-foreground">
                        {initials(thread.title) || "·"}
                      </span>
                    )
                  }
                  key={scopedThreadKey(ref)}
                  label={label}
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(ref),
                    })
                  }
                />
              );
            })
          : null}
        <RailButton
          active={threadsActive}
          icon={<MessagesSquareIcon />}
          label={gt("Threads")}
          onClick={openThreads}
        />
      </RailSection>
      <RailSection>
        <RailButton
          icon={<SquarePenIcon />}
          label={gt("New thread")}
          onClick={() => openCommandPalette({ open: "new-thread-in" })}
        />
        <RailButton icon={<SearchIcon />} label={gt("Search threads")} onClick={onSearch} />
        {pullRequestsSupported ? (
          <RailButton
            active={pathname === "/pull-requests"}
            icon={<PullRequestGlyph.pullRequest />}
            label={gt("Pull requests")}
            onClick={() =>
              void navigate({
                to: "/pull-requests",
                search: readPullRequestListPreferences(),
              })
            }
          />
        ) : null}
        {issuesSupported ? (
          <RailButton
            active={pathname === "/issues"}
            icon={<IssueGlyph.issue />}
            label={gt("Issues", { $context: "sidebar link to the list of issues" })}
            onClick={() => void navigate({ to: "/issues", search: readIssueListPreferences() })}
          />
        ) : null}
      </RailSection>
      <div className="mt-auto flex w-full flex-col items-center gap-1 border-t border-sidebar-border/70 py-2">
        <RailButton
          active={pathname === "/usage"}
          icon={<ChartNoAxesColumnIcon />}
          label={gt("Usage")}
          onClick={() => void navigate({ to: "/usage" })}
        />
        <RailButton
          active={pathname.startsWith("/settings")}
          icon={<SettingsIcon />}
          label={gt("Settings")}
          onClick={() => void navigate({ to: "/settings" })}
        />
      </div>
    </nav>
  );
}
