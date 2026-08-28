import { TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DesktopUpdateStatusIcon,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";

function resolveSidebarUpdatePresentation({
  action,
  isDownloading,
  showCheckIcon,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly isDownloading: boolean;
  readonly showCheckIcon: boolean;
}) {
  const showUpdateDetails = action !== "none" || isDownloading;
  const iconStatus = showCheckIcon
    ? "checking"
    : action === "install"
      ? "downloaded"
      : isDownloading
        ? "downloading"
        : action === "download"
          ? "available"
          : "idle";

  return {
    iconStatus,
    showUpdateDetails,
    showUpdateIconState: showUpdateDetails && !showCheckIcon,
  } as const;
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8 text-xs">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

export function SidebarUpdatePill() {
  return isElectron ? <SidebarUpdateControl /> : null;
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const [isActionPending, setIsActionPending] = useState(false);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(false);
  const updateButtonRef = useRef<HTMLButtonElement>(null);
  const firstReleaseLinkRef = useRef<HTMLAnchorElement>(null);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  useEffect(() => {
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (state?.status === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }, [prefersReducedMotion, state?.status]);

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking",
    prefersReducedMotion,
  });
  const { iconStatus, showUpdateDetails, showUpdateIconState } = resolveSidebarUpdatePresentation({
    action,
    isDownloading,
    showCheckIcon,
  });
  const tooltip = showUpdateDetails
    ? state
      ? getDesktopUpdateButtonTooltip(state)
      : "Update available"
    : showCheckIcon
      ? "Checking for updates…"
      : "Check for updates";
  const disabled = showCheckIcon
    ? true
    : showUpdateDetails
      ? isDesktopUpdateButtonDisabled(state)
      : !canCheckForUpdate(state);
  const isInteractionDisabled = disabled || isActionPending;

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (isInteractionDisabled) return;

    setIsActionPending(true);

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            showDesktopUpdateDownloadedToast(bridge, result.state);
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setIsActionPending(false));
      return;
    }

    if (action === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(state),
        );
      } catch (error) {
        setIsActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setIsActionPending(false));
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      })
      .finally(() => setIsActionPending(false));
  }, [action, isInteractionDisabled, prefersReducedMotion, state]);

  const handleCheckAnimationIteration = useCallback(() => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking",
        prefersReducedMotion,
      }),
    );
  }, [prefersReducedMotion, state?.status]);

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={updateButtonRef}
              type="button"
              aria-label={tooltip}
              aria-disabled={isInteractionDisabled || undefined}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2",
                isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
                showUpdateIconState
                  ? cn(
                      "bg-sidebar-control-surface text-sidebar-foreground",
                      !isInteractionDisabled && "hover:bg-sidebar-row-hover",
                    )
                  : cn(
                      "text-[var(--sidebar-icon-color)]",
                      !isInteractionDisabled &&
                        "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    ),
                disabled && !showUpdateIconState && "opacity-60",
              )}
              onClick={handleAction}
              onKeyDown={(event) => {
                if (
                  event.key !== "Tab" ||
                  event.shiftKey ||
                  !showUpdateDetails ||
                  state?.channel !== "nightly" ||
                  state.releaseNotes.length === 0 ||
                  !firstReleaseLinkRef.current
                ) {
                  return;
                }
                event.preventDefault();
                firstReleaseLinkRef.current.focus();
              }}
            >
              <DesktopUpdateStatusIcon
                key={showCheckIcon ? checkAnimationKey : iconStatus}
                downloadPercent={state?.downloadPercent ?? null}
                isCheckAnimating={showCheckIcon && !prefersReducedMotion}
                onCheckAnimationIteration={handleCheckAnimationIteration}
                status={iconStatus}
              />
            </button>
          }
        />
        <TooltipPopup
          align="center"
          className={
            showUpdateDetails && state?.channel === "nightly" && state.releaseNotes.length > 0
              ? // pointer-events-auto overrides the positioner's pointer-events-none so the
                // release notes stay open (and scrollable) when the cursor moves into them.
                "pointer-events-auto max-w-none text-balance"
              : undefined
          }
          side="top"
          variant={showUpdateDetails ? "glass" : "default"}
        >
          {showUpdateDetails && state ? (
            <SidebarUpdateReleaseNotes
              firstLinkRef={firstReleaseLinkRef}
              onBackTab={() => updateButtonRef.current?.focus()}
              shell={window.desktopBridge}
              state={state}
              tooltip={tooltip}
            />
          ) : (
            tooltip
          )}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
