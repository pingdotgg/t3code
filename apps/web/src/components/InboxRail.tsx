/**
 * The default chrome: a narrow icon column instead of a tree. Reports are the
 * only top-level object, so navigation is a few destinations rather than a
 * hierarchy. Repositories are managed from Settings.
 */
import { Link, useLocation } from "@tanstack/react-router";
import { CheckCheckIcon, GitPullRequestIcon, InboxIcon, SettingsIcon } from "lucide-react";
import { memo, type ReactElement } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { useEnvironments } from "../state/environments";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const RAIL_ITEM_CLASS =
  "flex size-8 items-center justify-center rounded-[var(--control-radius)] text-[var(--sidebar-icon-color)] outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 [&_svg]:size-4";

function railItemClass(isActive: boolean): string {
  return cn(RAIL_ITEM_CLASS, isActive && "bg-sidebar-row-selected text-sidebar-foreground");
}

/** One destination: the link is the tooltip trigger, so hover and focus share a target. */
function RailItem({ label, link }: { readonly label: string; readonly link: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

export const InboxRail = memo(function InboxRail() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  // One connected server offering pull requests is enough for the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );

  return (
    <nav
      aria-label="Main"
      className="flex h-dvh w-12 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar surface-grain text-sidebar-foreground"
      data-app-rail=""
    >
      <div
        className={cn(
          "h-[var(--workspace-topbar-height)] w-full shrink-0",
          isElectron && "drag-region",
        )}
      />
      <div className="flex flex-col items-center gap-1">
        <RailItem
          label="Inbox"
          link={
            <Link to="/inbox" aria-label="Inbox" className={railItemClass(pathname === "/inbox")}>
              <InboxIcon />
            </Link>
          }
        />
        <RailItem
          label="Done"
          link={
            <Link to="/done" aria-label="Done" className={railItemClass(pathname === "/done")}>
              <CheckCheckIcon />
            </Link>
          }
        />
        {pullRequestsSupported ? (
          <RailItem
            label="Pull requests"
            link={
              <Link
                to="/pull-requests"
                search={{ involvement: "all", state: "open" }}
                aria-label="Pull requests"
                className={railItemClass(pathname === "/pull-requests")}
              >
                <GitPullRequestIcon />
              </Link>
            }
          />
        ) : null}
      </div>
      <div className="mt-auto pb-2">
        <RailItem
          label="Settings"
          link={
            <Link
              to="/settings"
              aria-label="Settings"
              className={railItemClass(pathname.startsWith("/settings"))}
            >
              <SettingsIcon />
            </Link>
          }
        />
      </div>
    </nav>
  );
});
