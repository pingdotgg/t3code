import { memo, useCallback } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { APP_BASE_NAME, APP_VERSION } from "../../branding";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { SettingsHexIcon } from "../icons/custom";
import { LogomarkForma } from "../LogomarkForma";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { T3ConnectSidebarControl } from "../clerk/T3ConnectSidebarSignIn";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

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
  const identificationPillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  const stageBadgeLabel = identificationPillLabel ?? stageLabel;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative isolate h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center justify-between gap-2 overflow-hidden px-3 py-0 sm:px-4",
        isElectron && "drag-region md:pl-[var(--workspace-titlebar-content-left)]",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "text-white/90! [:hover,[data-pressed]]:bg-white/15 hover:text-white! focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:opacity-100!",
        )}
      />
      <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2">
        <Tooltip>
          <TooltipTrigger render={<SidebarBrand onBackdrop={backdropVariant !== null} />} />
          <TooltipPopup side="bottom" sideOffset={2}>
            Version {APP_VERSION}
          </TooltipPopup>
        </Tooltip>
        {stageBadgeLabel ? (
          <Badge
            className={cn(
              "sidebar-brand-stage rounded-full px-1.5",
              backdropVariant ? "bg-white/15 text-white" : "text-muted-foreground",
            )}
            data-build-stage=""
            {...(identificationPillLabel
              ? { "data-environment-identification": "pill" as const }
              : {})}
            size="sm"
            variant="secondary"
          >
            {stageBadgeLabel}
          </Badge>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              className={cn(
                "relative z-10 hidden shrink-0 md:inline-flex",
                backdropVariant &&
                  "text-white/90! [:hover,[data-pressed]]:bg-white/15 hover:text-white! focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:opacity-100!",
              )}
              data-testid="desktop-sidebar-collapse-trigger"
            />
          }
        />
        <TooltipPopup side="bottom">Collapse sidebar</TooltipPopup>
      </Tooltip>
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "sidebar-brand h-7 w-fit min-w-0 shrink-0 items-center gap-2 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <FormaWordmark />
    </Link>
  );
}

function FormaWordmark() {
  return (
    <span
      aria-label={APP_BASE_NAME}
      className="inline-flex shrink-0 items-center gap-2 font-semibold text-lg lowercase tracking-tight"
    >
      <LogomarkForma aria-hidden="true" className="h-5 w-auto shrink-0" />
      <span className="truncate">{APP_BASE_NAME}</span>
    </span>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <T3ConnectSidebarControl />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton className="gap-2 px-2 py-1.5" onClick={handleSettingsClick}>
            <SettingsHexIcon className="size-3.5" />
            <span className="text-xs">Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});
