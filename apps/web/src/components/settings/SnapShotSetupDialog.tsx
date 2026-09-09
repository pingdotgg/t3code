import {
  isModifierPairShortcut,
  type DesktopSnapShotSetupAction,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { CircleCheckIcon } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { CaptureShortcutConfig } from "./CaptureShortcutConfig";
import { Button } from "../ui/button";
import { Dialog, DialogDescription } from "../ui/dialog";
import { WizardSteps, WizardPopup, WizardHeader, WizardPanel, WizardFooter } from "../ui/wizard";
import {
  captureSetupAccessReady,
  captureSetupBackend,
  captureSetupCheckMessage,
  captureSetupDesktopName,
  captureSetupInitialStep,
  captureSetupMacPermissionsReady,
  captureSetupShortcutReady,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";

const SETUP_STEPS = [
  { id: "access", label: "Access" },
  { id: "shortcut", label: "Shortcut" },
] as const;

const GNOME_ACCESS_COPY = {
  "not-installed": {
    title: "Install the extension",
    description:
      "The T3 Code GNOME extension lets you capture other windows and bring them into your draft. Sign out once after installing.",
  },
  "restart-required": {
    title: "Extension installed",
    description: "Save your work, then sign out and back in. Your setup will be waiting here.",
  },
  "update-required": {
    title: "Update the extension",
    description: "Install the update, then sign out and back in.",
  },
  "extensions-disabled": {
    title: "Allow GNOME extensions",
    description: "Open GNOME Extensions and turn on extensions, then check again.",
  },
  disabled: {
    title: "Enable the extension",
    description: "Enable T3 Code SnapShots to start capturing windows.",
  },
  enabled: {
    title: "Capture is ready",
    description: "Next, choose your shortcut.",
  },
  unsupported: {
    title: "Automatic capture isn't available",
    description: "Use Take snapshot from the command palette to choose a window.",
  },
  error: {
    title: "Couldn't set up the extension",
    description: "Check T3 Code SnapShots in GNOME Extensions, then try again.",
  },
};

function ScreenRecordingIcon() {
  const gradientId = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      className="size-8 shrink-0 drop-shadow-[0_1px_1px_#0005]"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x2="0" y2="1">
          <stop stopColor="#ff6972" />
          <stop offset="1" stopColor="#ff2938" />
        </linearGradient>
      </defs>
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7"
        fill={`url(#${gradientId})`}
        stroke="#ffffff40"
      />
      <circle cx="16" cy="16" r="10" fill="none" stroke="#fff" strokeWidth="2" />
      <circle cx="16" cy="16" r="4.5" fill="#fff" />
    </svg>
  );
}

function AccessibilityPermissionIcon() {
  const gradientId = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      className="size-8 shrink-0 drop-shadow-[0_1px_1px_#0005]"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x2="0" y2="1">
          <stop stopColor="#48b6ff" />
          <stop offset="1" stopColor="#0085ff" />
        </linearGradient>
      </defs>
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7"
        fill={`url(#${gradientId})`}
        stroke="#ffffff40"
      />
      <circle cx="16" cy="16" r="10" fill="none" stroke="#fff" strokeWidth="1.75" />
      <circle cx="16" cy="10" r="1.6" fill="#fff" />
      <path
        d="m10 13 6 1 6-1M16 14v4m0 0-2.5 6m2.5-6 2.5 6"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MacPermissionRow({
  icon,
  title,
  description,
  granted,
  busy,
  onAllow,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  granted: boolean;
  busy: boolean;
  onAllow: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {granted ? (
        <span className="flex items-center gap-1 text-xs text-success">
          <CircleCheckIcon className="size-4" aria-hidden="true" />
          Allowed
        </span>
      ) : (
        <Button size="xs" variant="outline" disabled={busy} onClick={onAllow}>
          Allow
        </Button>
      )}
    </div>
  );
}

export function SnapShotSetupDialog({
  state,
  initialStep,
  wasEnabled,
  includeAccessibility,
  busy: actionBusy,
  error,
  shortcutInput,
  shortcutStatus,
  shortcutChanged,
  canSaveShortcut,
  onSaveShortcut,
  onEnable,
  onAction,
  onRefresh,
  onClose,
  onLeaveStep,
}: {
  state: DesktopSnapShotState;
  initialStep: CaptureSetupStep;
  wasEnabled: boolean;
  includeAccessibility: boolean;
  busy: boolean;
  error: string | null;
  shortcutInput: ReactNode;
  shortcutStatus: string | null | undefined;
  shortcutChanged: boolean;
  canSaveShortcut: boolean;
  onSaveShortcut: () => Promise<boolean>;
  onEnable: () => Promise<boolean>;
  onAction: (action: DesktopSnapShotSetupAction) => Promise<void>;
  onRefresh: () => Promise<DesktopSnapShotState | undefined>;
  onClose: (completed: boolean) => Promise<void>;
  onLeaveStep: () => void;
}) {
  const [step, setStep] = useState(() => captureSetupInitialStep(state, initialStep));
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const busy = actionBusy || checking || configBusy;
  const backend = captureSetupBackend(state);
  const configShortcut = backend === "niri" || backend === "hyprland";
  const desktop = captureSetupDesktopName(state);
  const extension = state.gnomeExtension;
  const helper = backend === "hyprland" ? state.hyprlandHelper : state.kdeHelper;
  const helperBackend = backend === "kde" || backend === "hyprland";
  const installHelper = backend === "hyprland" ? "install-hyprland-helper" : "install-kde-helper";
  const removeHelper = backend === "hyprland" ? "remove-hyprland-helper" : "remove-kde-helper";
  const accessReady = captureSetupAccessReady(state);
  const macPermissions = state.macPermissions;
  const macPermissionsReady = captureSetupMacPermissionsReady(state, includeAccessibility);
  const shortcutReady = captureSetupShortcutReady(state, shortcutChanged);
  const install = extension?.status === "not-installed" || extension?.status === "update-required";
  const enable = extension?.status === "disabled";
  useEffect(() => {
    if (!macPermissions || step !== "access") return;
    const refresh = () => void onRefresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [macPermissions, onRefresh, step]);
  const changeStep = (next: CaptureSetupStep) => {
    onLeaveStep();
    setChecked(false);
    setStep(next);
  };
  const checkAgain = async () => {
    if (busy) return;
    setChecking(true);
    setChecked(false);
    try {
      setChecked((await onRefresh()) !== undefined);
    } finally {
      setChecking(false);
    }
  };
  const accessCopy =
    state.message && !macPermissions
      ? {
          title: "Let's try that again",
          description: "Couldn't check snapshots. Try again to continue.",
        }
      : backend === "gnome" && extension
        ? extension.status === "enabled" && !accessReady
          ? {
              title: "Check capture access",
              description: "The extension isn't ready yet. Try again in a moment.",
            }
          : GNOME_ACCESS_COPY[extension.status]
        : helperBackend
          ? helper?.status === "ready"
            ? {
                title: "Capture is ready",
                description: "Next, choose your shortcut.",
              }
            : helper?.status === "error"
              ? {
                  title: "Let's fix capture access",
                  description: "Try reinstalling the capture helper, then check again.",
                }
              : {
                  title:
                    helper?.status === "update-required"
                      ? "Update the capture helper"
                      : "Allow snapshots",
                  description:
                    "T3 Code's capture helper lets you capture other apps and return to your draft. It's included with T3 Code.",
                }
          : backend === "niri"
            ? {
                title: "Capture is ready",
                description: "Next, choose your shortcut.",
              }
            : backend === "picker"
              ? {
                  title: "Choose a window each time",
                  description:
                    "Your desktop doesn't support automatic capture. You'll choose the window to capture instead.",
                }
              : {
                  title: "Allow snapshots",
                  description:
                    backend === "portal"
                      ? "Your desktop may ask for permission when you first capture."
                      : macPermissions
                        ? macPermissionsReady
                          ? "Test a snapshot of the current window. If macOS asks to bypass its window picker, choose Allow. The test image is discarded."
                          : "Allow each permission, then continue."
                        : "Allow access when prompted to start capturing windows.",
                };
  const title = step === "access" ? accessCopy.title : "Choose your shortcut";
  const description =
    step === "access"
      ? accessCopy.description
      : configShortcut
        ? "Click the shortcut, then press the keys you want."
        : state.mode === "portal"
          ? "Choose your keys, then approve the permission prompt if asked."
          : "Use both Shift keys, or record a different shortcut.";
  const stepIndex = SETUP_STEPS.findIndex(({ id }) => id === step);
  const details = [
    ...new Set(
      [
        error,
        ...(step === "access"
          ? [
              state.message,
              backend === "gnome" &&
              (extension?.status === "error" || extension?.status === "unsupported")
                ? extension.message
                : null,
              helperBackend && helper?.status === "error" ? helper.message : null,
            ]
          : []),
      ].filter((detail) => detail !== null),
    ),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) void onClose(false);
      }}
    >
      <WizardPopup showCloseButton={!busy}>
        <WizardHeader title={desktop ? `Set up snapshots for ${desktop}` : "Set up snapshots"}>
          <WizardSteps
            steps={SETUP_STEPS.map((item) => item.label)}
            currentStep={stepIndex}
            isStepDisabled={(index) => busy || index > stepIndex}
            onStepChange={(index) => {
              const next = SETUP_STEPS[index];
              if (next && next.id !== step) changeStep(next.id);
            }}
          />
        </WizardHeader>
        <WizardPanel>
          <div className="space-y-4 text-sm">
            <div className="space-y-2" aria-live="polite">
              <h3 className="flex items-center gap-2 font-medium">{title}</h3>
              <DialogDescription>{description}</DialogDescription>
            </div>
            {step === "access" ? (
              <>
                <p
                  role="status"
                  aria-atomic="true"
                  className={
                    checked && !busy && !error ? "text-xs text-muted-foreground" : "sr-only"
                  }
                >
                  {checked && !busy && !error ? captureSetupCheckMessage(state) : null}
                </p>
                {macPermissions ? (
                  <div className="space-y-2">
                    <MacPermissionRow
                      icon={<ScreenRecordingIcon />}
                      title="Screen Recording"
                      description="Capture the window you're using."
                      granted={macPermissions.screenRecording}
                      busy={busy}
                      onAllow={() => void onAction("allow-screen-recording")}
                    />
                    <MacPermissionRow
                      icon={<AccessibilityPermissionIcon />}
                      title="Accessibility"
                      description={
                        includeAccessibility
                          ? "Include text and controls from the captured app."
                          : "Optional. Include text and controls from the captured app."
                      }
                      granted={macPermissions.accessibility}
                      busy={busy}
                      onAllow={() => void onAction("allow-accessibility")}
                    />
                  </div>
                ) : null}
                {helperBackend && helper?.status === "error" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void onAction(installHelper)}
                  >
                    Reinstall helper
                  </Button>
                ) : null}
              </>
            ) : configShortcut ? (
              <CaptureShortcutConfig
                state={state}
                disabled={actionBusy || checking || !accessReady}
                onBusyChange={setConfigBusy}
                onSaved={onRefresh}
                onComplete={() => onClose(true)}
              />
            ) : (
              <div className="space-y-3">
                {shortcutInput}
                {shortcutStatus ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    {shortcutStatus}
                  </p>
                ) : null}
                {!shortcutChanged &&
                !state.shortcutRegistered &&
                !state.shortcutPending &&
                state.shortcutCanRetry !== false &&
                !isModifierPairShortcut(state.shortcut) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void onAction("retry-shortcut")}
                  >
                    {state.mode === "portal" ? "Shortcut permissions" : "Try again"}
                  </Button>
                ) : null}
              </div>
            )}
            {step === "shortcut" && !accessReady ? (
              <p role="alert" className="text-destructive">
                Capture needs attention. Go back to check access.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                Couldn't finish this step. Try again or check Advanced for help.
              </p>
            ) : null}
            {details.length > 0 || (step === "access" && (backend === "gnome" || helperBackend)) ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Advanced</summary>
                <div className="mt-3 space-y-3">
                  {details.map((detail) => (
                    <p key={detail} className="break-words">
                      {detail}
                    </p>
                  ))}
                  {step === "access" && (backend === "gnome" || helperBackend) ? (
                    <p>Included with T3 Code. No download needed.</p>
                  ) : null}
                  {step === "access" && backend === "gnome" && extension?.status === "enabled" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction("disable-extension")}
                    >
                      Disable extension
                    </Button>
                  ) : null}
                  {step === "access" && helperBackend && helper?.status !== "not-installed" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction(removeHelper)}
                    >
                      Remove capture helper
                    </Button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </WizardPanel>
        <WizardFooter>
          {step !== "access" ? (
            <Button variant="ghost" disabled={busy} onClick={() => changeStep("access")}>
              Back
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={() => void onClose(false)}>
            {wasEnabled ? "Close" : "Finish later"}
          </Button>
          {step === "access" ? (
            helperBackend && !accessReady && helper?.status !== "ready" ? (
              <Button
                disabled={busy}
                aria-busy={busy}
                onClick={() =>
                  void (helper?.status === "error" ? checkAgain() : onAction(installHelper))
                }
              >
                {checking
                  ? "Checking…"
                  : busy
                    ? "Installing…"
                    : helper?.status === "error"
                      ? "Check again"
                      : helper?.status === "update-required"
                        ? "Update helper"
                        : "Install helper"}
              </Button>
            ) : backend === "gnome" && !accessReady && extension?.status !== "enabled" ? (
              <Button
                disabled={busy}
                aria-busy={checking}
                onClick={() =>
                  void (install
                    ? onAction("install-extension")
                    : enable
                      ? onAction("enable-extension")
                      : checkAgain())
                }
              >
                {checking
                  ? "Checking…"
                  : busy
                    ? install
                      ? "Installing…"
                      : enable
                        ? "Enabling…"
                        : "Working…"
                    : install
                      ? extension?.status === "update-required"
                        ? "Update extension"
                        : "Install extension"
                      : enable
                        ? "Enable extension"
                        : "Check again"}
              </Button>
            ) : (
              <Button
                disabled={busy || !macPermissionsReady}
                onClick={async () => {
                  if (await onEnable()) changeStep("shortcut");
                }}
              >
                {busy
                  ? "Working…"
                  : macPermissions
                    ? "Test capture and continue"
                    : backend === "direct"
                      ? "Allow capture"
                      : !accessReady && !macPermissions
                        ? "Try again"
                        : "Continue"}
              </Button>
            )
          ) : !configShortcut ? (
            <Button
              disabled={
                busy || !accessReady || (shortcutChanged ? !canSaveShortcut : !shortcutReady)
              }
              onClick={async () => {
                if (!shortcutChanged || (await onSaveShortcut())) await onClose(true);
              }}
            >
              {busy ? "Saving…" : shortcutChanged ? "Save and finish" : "Done"}
            </Button>
          ) : null}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
