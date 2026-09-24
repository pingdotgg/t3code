import { ArrowLeftIcon, ArrowUpRightIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useState } from "react";
import { Link, useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { SidebarUsagePreview } from "./SidebarUsagePreview";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        "@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        // Over the stage artwork: the media viewer's control-on-imagery treatment.
        variant={backdropVariant ? "media-navigation" : "ghost"}
        className={cn(
          "relative top-auto z-10 translate-y-0 md:hidden",
          backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </div>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      {/* Center the visible capitals, without the font's ascender/descender space. */}
      <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
        <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
        <span
          className={cn(
            "truncate [text-box:trim-both_cap_alphabetic]",
            onBackdrop ? "text-white/70" : "text-muted-foreground",
          )}
        >
          Code
        </span>
      </span>
    </Link>
  );
}

/**
 * A footer icon button. Without a `preview` a press navigates to the page and
 * hover shows the label. With one, a press opens a glance at the page instead,
 * whose heading leads on to the page; the preview only mounts while open, so
 * its data subscriptions never run for an idle footer.
 */
function SidebarUtilityItem({
  icon,
  label,
  onClick,
  preview,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  preview?: ReactNode;
}) {
  if (!preview) {
    return (
      <SidebarMenuItem className="shrink-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
                {icon}
              </SidebarMenuButton>
            }
          />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
      </SidebarMenuItem>
    );
  }
  return (
    <SidebarUtilityPreviewItem icon={icon} label={label} onClick={onClick}>
      {preview}
    </SidebarUtilityPreviewItem>
  );
}

function SidebarUtilityPreviewItem({
  icon,
  label,
  onClick,
  children,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  // Opens on press only, never on hover: a panel that appears by itself is easy to trigger by
  // accident. Base UI moves focus in on open and back to the trigger on Escape or outside press.
  const [open, setOpen] = useState(false);
  return (
    <SidebarMenuItem className="shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip disabled={open}>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <SidebarMenuButton aria-label={label} size="icon">
                    {icon}
                  </SidebarMenuButton>
                }
              />
            }
          />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        <PopoverPopup
          align="center"
          aria-label={label}
          className="max-w-none shadow-xl shadow-black/25"
          // Rows are links that navigate in place; close so the glance does not outlive the page
          // it was about. Link handlers stop propagation, so this runs during capture.
          onClickCapture={(event) => {
            if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
          }}
          side="top"
          tooltipStyle
          viewportClassName="not-data-transitioning:overflow-y-auto"
        >
          <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2 p-1 text-xs">
            <InlineButton
              aria-label={`Open ${label}`}
              className="group/preview-heading w-fit gap-1 text-sm leading-5 font-medium text-foreground"
              onClick={() => {
                setOpen(false);
                onClick();
              }}
            >
              <span className="underline-offset-2 group-hover/preview-heading:underline">
                {label}
              </span>
              <ArrowUpRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
            </InlineButton>
            {children}
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : /^\/projects\/[^/]+\/?$/.test(location.pathname)
          ? "project-settings"
          : location.pathname === "/usage"
            ? "usage"
            : location.pathname === "/pull-requests"
              ? "pull-requests"
              : null,
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  return (
    <SidebarMenu className="flex-row items-center">
      {currentFooterPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
            // A drawer tap goes straight to the page; the glance is for the docked sidebar.
            preview={isMobile ? undefined : <SidebarUsagePreview />}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
