import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { managedUpdatesDenial } from "@t3tools/client-runtime/contract-labels";
import { type DesktopBridge, type DesktopUpdateState } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { type ComponentProps, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../../env";
import { m } from "../../i18n/messages";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePrimaryManagedPolicy } from "../../state/managedPolicy";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateIdleTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { useCheckForUpdates } from "../useCheckForUpdates";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DesktopUpdateStatusIcon,
  type DesktopUpdateStatusIconState,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";
import { SidebarUpdateCapsule, UpdateRunButton } from "./SidebarUpdateCapsule";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import type { UpdateEverythingRun, UpdateRunLocalState } from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  useUpdateEverythingRun,
} from "./updateEverythingRun";
import { type ReportLocalUpdateError, useUpdateEverything } from "./useUpdateEverything";

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return showUpdateDetails && (state?.releaseNotes.length ?? 0) > 0;
}

function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  if (details.reason === "trigger-press") details.cancel();
}

function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { readonly key: string; readonly shiftKey: boolean },
  handle: Pick<SidebarUpdatePopoverHandle, "open">,
  triggerId: string,
): void {
  if (event.key !== "Tab" || event.shiftKey) return;
  // Hover-open popovers do not manage focus. Promote this one before native Tab runs.
  flushSync(() => handle.open(triggerId));
}

function resolveSidebarUpdatePresentation({
  action,
  showsEverything,
  run,
  isDownloading,
  isChecking,
  isCheckIconLatched,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly showsEverything: boolean;
  readonly run: UpdateEverythingRun | null;
  readonly isDownloading: boolean;
  readonly isChecking: boolean;
  readonly isCheckIconLatched: boolean;
}) {
  const showUpdateDetails = action !== "none" || showsEverything || run !== null || isDownloading;
  // A provider check or the spin latch must not hide an update the app check just found.
  const showCheckIcon = !showUpdateDetails && (isChecking || isCheckIconLatched);
  const iconStatus: DesktopUpdateStatusIconState = showCheckIcon
    ? "checking"
    : isDownloading
      ? "downloading"
      : run !== null
        ? run.localVersion !== null && action === "install"
          ? "downloaded"
          : "everything"
        : showsEverything
          ? "everything"
          : action === "install"
            ? "downloaded"
            : action === "download"
              ? "available"
              : "idle";

  return {
    iconStatus,
    showCheckIcon,
    showUpdateDetails,
    showUpdateIconState: showUpdateDetails && !showCheckIcon,
  } as const;
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const messages = useMessages();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description =
    state && visible ? getArm64IntelBuildWarningDescription(state, messages) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>
        <T>Intel build on Apple Silicon</T>
      </AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

export async function downloadLocalUpdate(
  bridge: DesktopBridge,
  {
    notifyDownloaded,
    reportError = toastUpdateError,
  }: { readonly notifyDownloaded: boolean; readonly reportError?: ReportLocalUpdateError },
): Promise<boolean> {
  try {
    const result = await bridge.downloadUpdate();
    if (result.completed && notifyDownloaded) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (actionError) reportError(m(msg("Could not download update")), actionError);
    return result.completed;
  } catch (error) {
    reportError(
      m(msg("Could not start update download")),
      thrownErrorMessage(error, m) ?? m(msg("An unexpected error occurred.")),
    );
    return false;
  }
}

export async function installLocalUpdate(
  bridge: DesktopBridge,
  reportError: ReportLocalUpdateError = toastUpdateError,
  expectedVersion?: string,
): Promise<boolean> {
  try {
    const result = await bridge.installUpdate(expectedVersion);
    if (!result.accepted) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
      return false;
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (!actionError) return true;
    reportError(m(msg("Could not install update")), actionError);
    return false;
  } catch (error) {
    reportError(
      m(msg("Could not install update")),
      thrownErrorMessage(error, m) ?? m(msg("An unexpected error occurred.")),
    );
    return false;
  }
}

export function SidebarUpdatePill() {
  return <SidebarUpdateControl />;
}

function SidebarUpdateControl() {
  return <UpdateControl inSidebar />;
}

/**
 * Update check/install button. Callers own the visuals through
 * `className`; update availability is exposed as `data-update-state`.
 */
export function UpdateButton({ className }: { className?: string | undefined } = {}) {
  return <UpdateControl className={className} />;
}

function UpdateControl({
  className,
  inSidebar = false,
}: { className?: string | undefined; inSidebar?: boolean } = {}) {
  const state = useDesktopUpdateState();
  const gt = useGT();
  const messages = useMessages();
  // The desktop updates this machine, whose policy the primary environment reports.
  const updatesDenial = managedUpdatesDenial(usePrimaryManagedPolicy(), messages);
  const [isActionPending, setIsActionPending] = useState(false);
  const [check, setCheck] = useState<"button" | "dialog" | null>(null);
  const isCheckingEverything = check === "button";
  const [isConfirmingEverything, setIsConfirmingEverything] = useState(false);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const updateStatus = state?.status;
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(
    () => !prefersReducedMotion && updateStatus === "checking",
  );
  const [latchInputs, setLatchInputs] = useState({ prefersReducedMotion, updateStatus });
  if (
    latchInputs.prefersReducedMotion !== prefersReducedMotion ||
    latchInputs.updateStatus !== updateStatus
  ) {
    setLatchInputs({ prefersReducedMotion, updateStatus });
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (updateStatus === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const localUpdateVersion =
    state && action !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  const everything = useUpdateEverything(localUpdateVersion);
  const checkForUpdates = useCheckForUpdates();
  const runsEverything = everything.hasUpdates && !isDownloading;
  const run = useUpdateEverythingRun();
  const isRunningEverything = run !== null;
  const isChecking = state?.status === "checking" || isCheckingEverything;
  const { iconStatus, showCheckIcon, showUpdateDetails, showUpdateIconState } =
    resolveSidebarUpdatePresentation({
      action,
      showsEverything: runsEverything,
      run,
      isDownloading,
      isChecking,
      isCheckIconLatched: shouldShowDesktopUpdateCheckIcon({
        isAnimationLatched: isCheckAnimationLatched,
        isChecking,
        prefersReducedMotion,
      }),
    });
  const idleTooltip =
    !showUpdateDetails && !isChecking ? getDesktopUpdateIdleTooltip(state, updatesDenial) : null;
  const tooltip = runsEverything
    ? everything.summary
    : showUpdateDetails
      ? state
        ? getDesktopUpdateButtonTooltip(state)
        : "Update available"
      : isChecking
        ? "Checking for updates…"
        : (idleTooltip?.title ?? "Check for updates");
  // Only the app's own busy status disables; with its updater off, a check still covers servers and
  // providers. The spin latch releases on an animation event a paused animation never fires.
  const disabled = runsEverything
    ? false
    : showUpdateDetails
      ? isDesktopUpdateButtonDisabled(state)
      : state?.status === "checking" || state?.status === "downloading";
  // A run's button only opens its details, so a run never disables it.
  const isInteractionDisabled = !isRunningEverything && (disabled || isActionPending);
  const showReleaseNotesPopover = shouldUseSidebarUpdateReleaseNotesPopover(
    showUpdateDetails,
    state,
  );

  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseNotesTriggerFocusVisible, setReleaseNotesTriggerFocusVisible] = useState(false);
  // Release notes close when they stop applying, and open when they start
  // applying while the trigger already holds keyboard focus.
  const [releaseNotesShownBefore, setReleaseNotesShownBefore] = useState(showReleaseNotesPopover);
  if (releaseNotesShownBefore !== showReleaseNotesPopover) {
    setReleaseNotesShownBefore(showReleaseNotesPopover);
    setReleaseNotesOpen(showReleaseNotesPopover && releaseNotesTriggerFocusVisible);
  }

  const handleAction = async () => {
    const bridge = window.desktopBridge;
    if (isInteractionDisabled) return;

    if (runsEverything) {
      setIsConfirmingEverything(true);
      // A newer build of this app, and machines that cached an older latest version, add their rows
      // while the dialog is open.
      setCheck("dialog");
      void checkForUpdates({ errorsOnly: true }).finally(() => setCheck(null));
      return;
    }

    if (bridge && state && action === "download") {
      setIsActionPending(true);
      void downloadLocalUpdate(bridge, { notifyDownloaded: true }).finally(() =>
        setIsActionPending(false),
      );
      return;
    }

    if (bridge && state && action === "install") {
      setIsActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(state),
          { initialFocus: "confirm" },
        );
      } catch (error) {
        setIsActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not confirm update"),
            description: thrownErrorMessage(error, m) ?? gt("Update confirmation failed."),
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsActionPending(false);
        return;
      }
      void installLocalUpdate(bridge).finally(() => setIsActionPending(false));
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    setCheck("button");
    void checkForUpdates().finally(() => setCheck(null));
  };

  const runEverything = async () => {
    const bridge = window.desktopBridge;
    setIsConfirmingEverything(false);
    setIsActionPending(true);
    const result = await settlePromise(() =>
      everything.run({
        ...(bridge && action === "download"
          ? {
              downloadLocal: (reportError) =>
                downloadLocalUpdate(bridge, { notifyDownloaded: false, reportError }),
            }
          : {}),
        ...(bridge && action !== "none"
          ? { installLocal: (reportError) => installLocalUpdate(bridge, reportError) }
          : {}),
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not update everything"),
          description: thrownErrorMessage(error, m) ?? gt("An unexpected error occurred."),
        }),
      );
    }
    setIsActionPending(false);
  };

  const handleCheckAnimationIteration = () => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking" || isCheckingEverything,
        prefersReducedMotion,
      }),
    );
  };

  const statusIcon = (
    <DesktopUpdateStatusIcon
      key={showCheckIcon ? checkAnimationKey : iconStatus}
      downloadPercent={state?.downloadPercent ?? null}
      isCheckAnimating={showCheckIcon && !prefersReducedMotion}
      onCheckAnimationIteration={handleCheckAnimationIteration}
      status={iconStatus}
    />
  );
  const confirmDialog = (
    <UpdateEverythingDialog
      open={isConfirmingEverything}
      onOpenChange={setIsConfirmingEverything}
      version={everything.version}
      providerCount={everything.providerCount}
      rows={everything.rows}
      restarts={everything.restarts}
      checking={check === "dialog"}
      onConfirm={() => void runEverything()}
    />
  );

  const buttonClassName =
    className ??
    cn(
      "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
      isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
      showUpdateIconState || run !== null
        ? cn(
            "bg-sidebar-control-surface text-sidebar-foreground",
            !isInteractionDisabled && "hover:bg-sidebar-row-hover",
          )
        : cn(
            "text-(--sidebar-icon-color)",
            !isInteractionDisabled && "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          ),
      disabled && !showUpdateIconState && "opacity-60",
    );

  if (run !== null) {
    const local: UpdateRunLocalState =
      run.localVersion === null
        ? null
        : state?.status === "downloading"
          ? { status: "downloading", percent: state.downloadPercent }
          : { status: "waiting" };
    const bridge = window.desktopBridge;
    const onRestart =
      run.localVersion === null && action === "install" && bridge
        ? async () => {
            saveUpdateEverythingResult({
              localVersion: localUpdateVersion,
              updatedServers: 0,
              updatedProviders: 0,
              failures: [],
              restarting: [],
            });
            if (!(await installLocalUpdate(bridge))) clearSavedUpdateEverythingResult();
          }
        : undefined;
    return inSidebar ? (
      <SidebarMenuItem className="ml-auto flex flex-1">
        <SidebarUpdateCapsule run={run} local={local} icon={statusIcon} onRestart={onRestart} />
        {confirmDialog}
      </SidebarMenuItem>
    ) : (
      <UpdateRunButton
        run={run}
        local={local}
        icon={statusIcon}
        onRestart={onRestart}
        className={buttonClassName}
        updateState={iconStatus}
      />
    );
  }

  const updateButton = (
    <button
      type="button"
      aria-label={
        idleTooltip?.detail
          ? gt("{tooltip}: {detail}", { tooltip, detail: idleTooltip.detail })
          : tooltip
      }
      aria-disabled={isInteractionDisabled || undefined}
      data-update-state={iconStatus}
      className={buttonClassName}
      onClick={handleAction}
      onBlur={() => {
        suppressReleaseNotesFocusOpen.current = false;
        setReleaseNotesTriggerFocusVisible(false);
      }}
      onFocus={(event) => {
        const focusVisible = event.currentTarget.matches(":focus-visible");
        setReleaseNotesTriggerFocusVisible(focusVisible);
        if (!showReleaseNotesPopover || !focusVisible) return;
        if (suppressReleaseNotesFocusOpen.current) {
          suppressReleaseNotesFocusOpen.current = false;
          return;
        }
        flushSync(() => releaseNotesPopoverHandle.open(releaseNotesTriggerId));
      }}
      onKeyDown={(event) => {
        if (!showReleaseNotesPopover) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(
          event,
          releaseNotesPopoverHandle,
          releaseNotesTriggerId,
        );
      }}
    >
      {statusIcon}
    </button>
  );

  const control = (
    <>
      <Popover
        handle={releaseNotesPopoverHandle}
        open={releaseNotesOpen && showReleaseNotesPopover}
        triggerId={releaseNotesTriggerId}
        onOpenChange={(open, details) => {
          if (open && !showReleaseNotesPopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
          if (!details.isCanceled) setReleaseNotesOpen(open);
        }}
      >
        <Tooltip disabled={showReleaseNotesPopover}>
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              <PopoverTrigger
                {...(!showReleaseNotesPopover
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={releaseNotesPopoverHandle}
                id={releaseNotesTriggerId}
                openOnHover={showReleaseNotesPopover}
                render={updateButton}
              />
            }
          />
          {!showReleaseNotesPopover ? (
            <TooltipPopup
              align="center"
              side="top"
              variant={showUpdateDetails ? "glass" : "default"}
            >
              {idleTooltip?.detail ? (
                <div className="text-left">
                  <div className="font-medium">{idleTooltip.title}</div>
                  <div className="text-muted-foreground">{idleTooltip.detail}</div>
                </div>
              ) : (
                <span className="whitespace-pre-line">{tooltip}</span>
              )}
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover && state ? (
          <PopoverPopup
            align="center"
            aria-label={gt("Update release notes")}
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                releaseNotesPopupRef.current?.contains(document.activeElement)
              ) {
                suppressReleaseNotesFocusOpen.current = true;
              }
            }}
            ref={releaseNotesPopupRef}
            side="top"
            tooltipStyle
          >
            <SidebarUpdateReleaseNotes
              shell={window.desktopBridge}
              state={state}
              tooltip={tooltip}
            />
          </PopoverPopup>
        ) : null}
      </Popover>
      {confirmDialog}
    </>
  );

  return inSidebar ? (
    <SidebarMenuItem className="ml-auto shrink-0">{control}</SidebarMenuItem>
  ) : (
    control
  );
}
