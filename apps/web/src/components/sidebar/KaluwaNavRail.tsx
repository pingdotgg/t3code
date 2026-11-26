// Fork: Kaluwa's navigation strip. A narrow column left of the thread sidebar that
// stays put when the sidebar hides, with a usage ring group per subscription account.
import { useAtomValue } from "@effect/atom-react";
import {
  normalizeProviderAccentColor,
  providerInstanceInitials,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { collectLimitAccounts, type LimitAccount } from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import {
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  HouseIcon,
  PuzzleIcon,
  SearchIcon,
  SettingsIcon,
  WorkflowIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "../../lib/utils";
import {
  useIssuesSupported,
  usePrimaryEnvironmentId,
  usePullRequestsSupported,
} from "../../state/environments";
import { extensionsNeedAttentionAtom } from "../../state/extensions";
import { environmentPresentations } from "../../state/presentation";
import { IssueGlyph } from "../issue/issuePresentation";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "../usage/UsageLimits";
import { useWorkflowEnvironmentIds } from "../workflows/useWorkflowEnvironmentIds";
import { accountInitials, collectUsageRingGroups, type UsageRingGroup } from "./kaluwaUsageRings";

const SCHEDULED_TASKS_PATH = "/settings/scheduled-tasks";

const RAIL_BUTTON_CLASS =
  "relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag] [&_svg]:size-[18px]";

function RailButton({
  label,
  active = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={onClick}
            className={cn(
              RAIL_BUTTON_CLASS,
              active && "bg-sidebar-row-hover text-sidebar-foreground",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function accountColor(account: LimitAccount): string {
  return normalizeProviderAccentColor(account.accentColor) ?? barColor(account.driver);
}

function accountTitle(account: LimitAccount): string {
  return (
    account.displayName ?? providerClients.get(account.driver)?.label ?? String(account.driver)
  );
}

// Sized so three rings still leave room for the provider's logo in the middle.
const RING_BOX = 36;
const RING_STROKE = 2.5;
const RING_GAP = 1;

function UsageRings({
  rings,
  color,
}: {
  readonly rings: readonly ServerProviderUsageWindow[];
  readonly color: string;
}) {
  const center = RING_BOX / 2;
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
      className="size-9 -rotate-90"
      style={{ color }}
    >
      {rings.map((window, index) => {
        const radius = center - RING_STROKE / 2 - index * (RING_STROKE + RING_GAP);
        const circumference = 2 * Math.PI * radius;
        const used = Math.min(100, Math.max(0, window.usedPercent)) / 100;
        return (
          <g key={window.id}>
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.18}
              strokeWidth={RING_STROKE}
            />
            {used > 0 ? (
              <circle
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={`${used * circumference} ${circumference}`}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Mounted only while the tooltip is open, so the countdowns tick only then. */
function UsageRingDetails({ group }: { readonly group: UsageRingGroup }) {
  const gt = useGT();
  const m = useMessages();
  const now = useNowSecond();
  const { account } = group;
  const color = accountColor(account);
  return (
    <div className="flex min-w-48 flex-col gap-1.5 py-0.5">
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="font-medium">{accountTitle(account)}</span>
        {account.email ? (
          <span className="text-muted-foreground">{accountInitials(account.email)}</span>
        ) : null}
        {account.plan ? (
          <span className="ml-auto text-muted-foreground capitalize">{account.plan}</span>
        ) : null}
      </div>
      {group.windows.map((window) => {
        const reset = formatResetsIn(window, now, m);
        return (
          <div key={window.id} className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">{window.label}</span>
            <span className="tabular-nums">
              {gt("{used}% used", { used: Math.round(window.usedPercent) })}
              {reset ? <span className="text-muted-foreground">{` · ${reset}`}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function UsageRingButton({
  group,
  showInitials,
  onClick,
}: {
  readonly group: UsageRingGroup;
  /** Set when another account shares this one's name, so the two tell apart at a glance. */
  readonly showInitials: boolean;
  readonly onClick: () => void;
}) {
  const gt = useGT();
  const { account } = group;
  const summary = group.windows
    .map((window) => `${window.label} ${Math.round(window.usedPercent)}%`)
    .join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={gt("{account} usage: {summary}", {
              account: accountTitle(account),
              summary,
            })}
            onClick={onClick}
            className="flex w-10 shrink-0 cursor-pointer flex-col items-center gap-0.5 rounded-lg py-1 outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag]"
          />
        }
      >
        <span className="relative flex size-9 items-center justify-center">
          <UsageRings rings={group.rings} color={accountColor(account)} />
          <ProviderInstanceIcon
            driverKind={account.driver}
            displayName={accountTitle(account)}
            accentColor={account.accentColor}
            className="absolute inset-0 m-auto size-3"
            iconClassName="size-3"
          />
        </span>
        <span className="w-full truncate text-center text-3xs leading-tight font-medium text-sidebar-muted-foreground">
          {providerInstanceInitials(accountTitle(account))}
        </span>
        {showInitials && account.email ? (
          <span className="text-3xs leading-none text-sidebar-muted-foreground/70">
            {accountInitials(account.email)}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="right" align="end">
        <UsageRingDetails group={group} />
      </TooltipPopup>
    </Tooltip>
  );
}

function UsageRingStack({ onOpenUsage }: { readonly onOpenUsage: () => void }) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const groups = collectUsageRingGroups(collectLimitAccounts(presentations));
  if (groups.length === 0) return null;
  const titleCounts = new Map<string, number>();
  for (const group of groups) {
    const title = accountTitle(group.account);
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  return (
    <div className="flex flex-col items-center gap-1">
      {groups.map((group) => (
        <UsageRingButton
          key={group.key}
          group={group}
          showInitials={(titleCounts.get(accountTitle(group.account)) ?? 0) > 1}
          onClick={onOpenUsage}
        />
      ))}
    </div>
  );
}

/** Shows the last list the Extensions page loaded; the rail never starts a check itself. */
function ExtensionsRailButton({ active }: { readonly active: boolean }) {
  const gt = useGT();
  const navigate = useNavigate();
  const needsAttention = useAtomValue(extensionsNeedAttentionAtom(usePrimaryEnvironmentId()));
  return (
    <RailButton
      label={needsAttention ? gt("Extensions (some need attention)") : gt("Extensions")}
      active={active}
      onClick={() => void navigate({ to: "/extensions" })}
    >
      <PuzzleIcon />
      {needsAttention ? (
        <span aria-hidden className="absolute end-1.5 top-1.5 size-1.5 rounded-full bg-warning" />
      ) : null}
    </RailButton>
  );
}

export const KaluwaNavRail = memo(function KaluwaNavRail() {
  const gt = useGT();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const workflowsReachable = useWorkflowEnvironmentIds().length > 0;
  const { open: threadSidebarOpen } = useSidebar();
  const openUsage = () => void navigate({ to: "/usage" });
  return (
    <nav
      aria-label={gt("App navigation")}
      data-kaluwa-rail=""
      className={cn(
        "relative z-20 hidden h-full w-(--kaluwa-rail-width) shrink-0 flex-col items-center gap-1 pb-3 text-sidebar-foreground md:flex",
        // The window's own controls sit in the titlebar row above the strip.
        "pt-(--workspace-topbar-height)",
        isElectron && "[-webkit-app-region:drag]",
      )}
    >
      {/* The strip starts below the titlebar row, so its edge never cuts through the window
          controls; while the thread sidebar shows, its header runs across that row instead. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 -z-10 bg-sidebar",
          threadSidebarOpen
            ? "top-(--workspace-topbar-height) [mask-image:linear-gradient(to_bottom,transparent,black_1.75rem)]"
            : "top-0",
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 top-(--workspace-topbar-height) w-px bg-sidebar-border"
      />
      <RailButton
        label={gt("Home")}
        active={pathname === "/"}
        onClick={() => void navigate({ to: "/" })}
      >
        <HouseIcon />
      </RailButton>
      <RailButton label={gt("Search")} onClick={() => openCommandPalette()}>
        <SearchIcon />
      </RailButton>
      {pullRequestsSupported ? (
        <RailButton
          label={gt("Pull requests")}
          active={pathname === "/pull-requests"}
          onClick={() =>
            void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() })
          }
        >
          <PullRequestGlyph.pullRequest />
        </RailButton>
      ) : null}
      {issuesSupported ? (
        <RailButton
          label={gt("Issues", { $context: "sidebar link to the list of issues" })}
          active={pathname === "/issues"}
          onClick={() => void navigate({ to: "/issues", search: readIssueListPreferences() })}
        >
          <IssueGlyph.issue />
        </RailButton>
      ) : null}
      {workflowsReachable ? (
        <RailButton
          label={gt("Workflows")}
          active={pathname === "/workflows"}
          onClick={() => void navigate({ to: "/workflows" })}
        >
          <WorkflowIcon />
        </RailButton>
      ) : null}
      <RailButton
        label={gt("Scheduled tasks")}
        active={pathname === SCHEDULED_TASKS_PATH}
        onClick={() => void navigate({ to: SCHEDULED_TASKS_PATH })}
      >
        <CalendarClockIcon />
      </RailButton>
      <ExtensionsRailButton active={pathname === "/extensions"} />
      <RailButton label={gt("Usage")} active={pathname === "/usage"} onClick={openUsage}>
        <ChartNoAxesColumnIcon />
      </RailButton>
      <div className="min-h-2 flex-1" />
      <UsageRingStack onOpenUsage={openUsage} />
      <RailButton
        label={gt("Settings")}
        active={
          (pathname === "/settings" || pathname.startsWith("/settings/")) &&
          pathname !== SCHEDULED_TASKS_PATH
        }
        onClick={() => void navigate({ to: "/settings" })}
      >
        <SettingsIcon />
      </RailButton>
    </nav>
  );
});
