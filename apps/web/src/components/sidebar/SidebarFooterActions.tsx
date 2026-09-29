import { useCallback } from "react";
import { GitPullRequestIcon, RefreshCwIcon, SettingsIcon, SparklesIcon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import {
  useLocalRebuildStaleness,
  useLocalRebuildState,
  useRequestLocalRebuild,
} from "../../hooks/useLocalRebuild";
import { useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { SidebarFooter, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

const FOOTER_ICON_BUTTON_CLASS =
  "inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/65 transition-colors outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";
const FOOTER_ICON_BUTTON_ACTIVE_CLASS = "bg-accent text-foreground";
const FOOTER_ICON_CLASS = "size-4";

export function SidebarFooterActions() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const showPullRequests = useSettings((s) => s.sidebarShowPullRequests);
  const showSkills = useSettings((s) => s.sidebarShowSkills);
  const rebuildState = useLocalRebuildState();
  const checkMinutes = useSettings((s) => s.localRebuildStalenessCheckMinutes);
  const { staleness, checking } = useLocalRebuildStaleness({
    enabled: rebuildState?.enabled === true,
    intervalMinutes: checkMinutes,
  });
  const { requestLocalRebuild, isStartingLocalRebuild } = useRequestLocalRebuild();

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/pull-requests", search: { involvement: "all" } });
  }, [closeMobileSidebar, navigate]);

  const handleSkillsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/skills" });
  }, [closeMobileSidebar, navigate]);

  const isSettingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const isPullRequestsActive = pathname.startsWith("/pull-requests");
  const isSkillsActive = pathname === "/skills" || pathname.startsWith("/skills/");

  // The rebuild shortcut only exists in packaged Dev builds; everywhere else
  // the footer is just the navigation icons.
  const showRebuild = rebuildState?.enabled === true;
  const rebuildBusy = checking || isStartingLocalRebuild;
  const rebuildBehind = staleness?.behind === true;
  const remoteRef =
    staleness?.remoteBranch !== null && staleness?.remoteBranch !== undefined
      ? `origin/${staleness.remoteBranch}`
      : "the remote default branch";
  const rebuildTooltip = !staleness
    ? "Checking for source updates…"
    : rebuildBehind
      ? staleness.behindBy !== null && staleness.behindBy !== undefined
        ? `${remoteRef} has ${staleness.behindBy} new ${staleness.behindBy === 1 ? "commit" : "commits"} — pull, rebuild and restart`
        : `${remoteRef} has newer changes — pull, rebuild and restart`
      : staleness.error
        ? `Could not check for source updates: ${staleness.error}`
        : "No rebuild needed";

  return (
    <SidebarFooter className="p-2">
      <SidebarUpdatePill />
      <div aria-label="Sidebar shortcuts" className="flex items-center gap-1" role="group">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label="Settings"
                className={cn(
                  FOOTER_ICON_BUTTON_CLASS,
                  isSettingsActive && FOOTER_ICON_BUTTON_ACTIVE_CLASS,
                )}
                data-testid="sidebar-footer-settings"
                onClick={handleSettingsClick}
                title="Settings"
                type="button"
              />
            }
          >
            <SettingsIcon className={FOOTER_ICON_CLASS} />
          </TooltipTrigger>
          <TooltipPopup side="top">Settings</TooltipPopup>
        </Tooltip>
        {showPullRequests ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label="Pull Requests"
                  className={cn(
                    FOOTER_ICON_BUTTON_CLASS,
                    isPullRequestsActive && FOOTER_ICON_BUTTON_ACTIVE_CLASS,
                  )}
                  data-testid="sidebar-footer-pull-requests"
                  onClick={handlePullRequestsClick}
                  title="Pull Requests"
                  type="button"
                />
              }
            >
              <GitPullRequestIcon className={FOOTER_ICON_CLASS} />
            </TooltipTrigger>
            <TooltipPopup side="top">Pull Requests</TooltipPopup>
          </Tooltip>
        ) : null}
        {showSkills ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label="Skills"
                  className={cn(
                    FOOTER_ICON_BUTTON_CLASS,
                    isSkillsActive && FOOTER_ICON_BUTTON_ACTIVE_CLASS,
                  )}
                  data-testid="sidebar-footer-skills"
                  onClick={handleSkillsClick}
                  title="Skills"
                  type="button"
                />
              }
            >
              <SparklesIcon className={FOOTER_ICON_CLASS} />
            </TooltipTrigger>
            <TooltipPopup side="top">Skills</TooltipPopup>
          </Tooltip>
        ) : null}
        {showRebuild ? (
          <span className="ml-auto flex items-center">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label="Rebuild and restart"
                    className={cn(
                      "inline-flex size-7 items-center justify-center rounded-md outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
                      rebuildBehind
                        ? "cursor-pointer text-muted-foreground/65 hover:bg-accent hover:text-foreground"
                        : "cursor-default text-muted-foreground/40",
                      rebuildBehind && FOOTER_ICON_BUTTON_ACTIVE_CLASS,
                    )}
                    data-testid="sidebar-footer-rebuild"
                    disabled={!rebuildBehind || rebuildBusy}
                    onClick={() => requestLocalRebuild({ pullLatest: true })}
                    // Native fallback: disabled buttons do not fire the hover
                    // events the popup relies on.
                    title={rebuildTooltip}
                    type="button"
                  />
                }
              >
                <RefreshCwIcon className={cn(FOOTER_ICON_CLASS, rebuildBusy && "animate-spin")} />
              </TooltipTrigger>
              <TooltipPopup side="top">{rebuildTooltip}</TooltipPopup>
            </Tooltip>
          </span>
        ) : null}
      </div>
    </SidebarFooter>
  );
}
