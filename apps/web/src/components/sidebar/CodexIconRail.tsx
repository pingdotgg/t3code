import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  ClockIcon,
  FolderIcon,
  HomeIcon,
  LayoutGridIcon,
  MoreHorizontalIcon,
  OrbitIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { cn } from "~/lib/utils";
import { useIssuesSupported, usePullRequestsSupported } from "../../state/environments";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { IssueGlyph } from "../issue/issuePresentation";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useNavigateToMainApp } from "./mainAppLocation";

function UsageRingIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.9"
      viewBox="0 0 20 20"
    >
      <circle cx="10" cy="10" r="6.75" opacity="0.28" />
      <path d="M10 3.25A6.75 6.75 0 0 1 16.75 10" />
      <path d="M15.1 14.4A6.75 6.75 0 0 1 4.9 14.4" />
    </svg>
  );
}

function RailNavButton({
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
            aria-current={active ? "page" : undefined}
            aria-label={label}
            onClick={onClick}
            size="icon-sm"
            variant={active ? "rail-active" : "rail"}
          >
            {icon}
          </Button>
        }
      />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function CodexIconRail() {
  const gt = useGT();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const pathname = useLocation({ select: (location) => location.pathname });
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();

  const isProjects = pathname === "/settings/projects" || pathname.startsWith("/projects/");
  const isAutomations = pathname === "/settings/scheduled-tasks";
  const isWorkflows = pathname === "/workflows";
  const isProviders =
    pathname === "/settings/providers" ||
    pathname === "/settings/browser" ||
    pathname === "/settings/connections";
  const isPullRequests = pathname === "/pull-requests";
  const isIssues = pathname === "/issues";
  const isUsage = pathname === "/usage";
  const isSettings =
    pathname.startsWith("/settings") && !isProjects && !isAutomations && !isProviders;
  const isThreads =
    !isProjects &&
    !isAutomations &&
    !isWorkflows &&
    !isProviders &&
    !isPullRequests &&
    !isIssues &&
    !isUsage &&
    !isSettings;

  return (
    <aside
      aria-label={gt("Sidebar")}
      data-codex-icon-rail="true"
      className="relative z-20 hidden w-11 shrink-0 flex-col items-center bg-sidebar pb-2.5 text-sidebar-foreground md:flex"
    >
      <div className="h-[var(--workspace-topbar-height)] w-full shrink-0" />
      <nav aria-label={gt("Navigation")} className="flex flex-col items-center gap-1.5">
        <RailNavButton
          active={isThreads}
          icon={<HomeIcon className={cn("size-4", isThreads && "fill-current")} />}
          label={gt("Threads")}
          onClick={() => void navigateToMainApp()}
        />
        <RailNavButton
          active={isProjects}
          icon={<FolderIcon className="size-4" />}
          label={gt("Projects")}
          onClick={() => void navigate({ to: "/settings/projects" })}
        />
        <RailNavButton
          active={isAutomations}
          icon={<ClockIcon className="size-4" />}
          label={gt("Automations")}
          onClick={() => void navigate({ to: "/settings/scheduled-tasks" })}
        />
        <RailNavButton
          active={isWorkflows}
          icon={<OrbitIcon className="size-4" />}
          label={gt("Workflows")}
          onClick={() => void navigate({ to: "/workflows" })}
        />
        <div
          aria-hidden="true"
          className="my-0.5 flex h-4 w-full items-center justify-center text-sidebar-muted-foreground/55"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </div>
        {pullRequestsSupported ? (
          <RailNavButton
            active={isPullRequests}
            icon={<PullRequestGlyph.pullRequest className="size-4" />}
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
          <RailNavButton
            active={isIssues}
            icon={<IssueGlyph.issue className="size-4" />}
            label={gt("Issues", { $context: "sidebar link to the list of issues" })}
            onClick={() => void navigate({ to: "/issues", search: readIssueListPreferences() })}
          />
        ) : null}
        <RailNavButton
          active={isProviders}
          icon={<LayoutGridIcon className="size-4" />}
          label={gt("Providers")}
          onClick={() => void navigate({ to: "/settings/providers" })}
        />
      </nav>
      <div className="mt-auto flex flex-col items-center gap-1 pt-2">
        <RailNavButton
          active={isUsage}
          icon={<UsageRingIcon />}
          label={gt("Usage")}
          onClick={() => void navigate({ to: "/usage" })}
        />
        <RailNavButton
          active={isSettings}
          icon={<SettingsIcon className="size-4" />}
          label={gt("Settings")}
          onClick={() => void navigate({ to: "/settings" })}
        />
      </div>
    </aside>
  );
}
