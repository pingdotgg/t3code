import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import {
  isModifierPairShortcut,
  type DesktopSnapShotSetupAction,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../Icons";
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
  captureSetupShortcutReady,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";

const SETUP_STEPS = [
  {
    id: "access",
    get label() {
      return t({ message: "Access" });
    },
  },
  {
    id: "shortcut",
    get label() {
      return t({ message: "Shortcut" });
    },
  },
] as const;

const GNOME_ACCESS_COPY = {
  "not-installed": {
    get title() {
      return t({ message: "Install the extension" });
    },
    get description() {
      return t({
        message:
          "The T3 Code GNOME extension lets you capture other windows and bring them into your draft. Sign out once after installing.",
      });
    },
  },
  "restart-required": {
    get title() {
      return t({ message: "Extension installed" });
    },
    get description() {
      return t({
        message: "Save your work, then sign out and back in. Your setup will be waiting here.",
      });
    },
  },
  "update-required": {
    get title() {
      return t({ message: "Update the extension" });
    },
    get description() {
      return t({ message: "Install the update, then sign out and back in." });
    },
  },
  "extensions-disabled": {
    get title() {
      return t({ message: "Allow GNOME extensions" });
    },
    get description() {
      return t({ message: "Open GNOME Extensions and turn on extensions, then check again." });
    },
  },
  disabled: {
    get title() {
      return t({ message: "Enable the extension" });
    },
    get description() {
      return t({ message: "Enable T3 Code SnapShots to start capturing windows." });
    },
  },
  enabled: {
    get title() {
      return t({ message: "Capture is ready" });
    },
    get description() {
      return t({ message: "Next, choose your shortcut." });
    },
  },
  unsupported: {
    get title() {
      return t({ message: "Automatic capture isn't available" });
    },
    get description() {
      return t({ message: "Use Take snapshot from the command palette to choose a window." });
    },
  },
  error: {
    get title() {
      return t({ message: "Couldn't set up the extension" });
    },
    get description() {
      return t({ message: "Check T3 Code SnapShots in GNOME Extensions, then try again." });
    },
  },
};

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
  const permissionStatus = usePermissionStatus(
    async () => {
      const refreshed = await onRefresh();
      if (!refreshed?.macPermissions) throw new Error("Permission status unavailable");
      return refreshed.macPermissions;
    },
    state.macPermissions ?? { screenRecording: false, accessibility: false },
    Boolean(state.macPermissions) && step === "access" && !busy,
  );
  const macPermissions = state.macPermissions ? permissionStatus.status : undefined;
  const macPermissionsReady =
    !macPermissions ||
    permissionStatus.isReady(
      includeAccessibility ? ["screenRecording", "accessibility"] : ["screenRecording"],
    );
  const shortcutReady = captureSetupShortcutReady(state, shortcutChanged);
  const install = extension?.status === "not-installed" || extension?.status === "update-required";
  const enable = extension?.status === "disabled";
  const changeStep = (next: CaptureSetupStep) => {
    onLeaveStep();
    setChecked(false);
    setStep(next);
  };
  const checkAgain = async () => {
    if (busy) return;
    setChecking(true);
    setChecked(false);
    const refreshed = await onRefresh().finally(() => setChecking(false));
    setChecked(refreshed !== undefined);
  };
  const accessCopy =
    state.message && !macPermissions
      ? {
          title: t({ message: "Let's try that again" }),
          description: t({ message: "Couldn't check snapshots. Try again to continue." }),
        }
      : backend === "gnome" && extension
        ? extension.status === "enabled" && !accessReady
          ? {
              title: t({ message: "Check capture access" }),
              description: t({ message: "The extension isn't ready yet. Try again in a moment." }),
            }
          : GNOME_ACCESS_COPY[extension.status]
        : helperBackend
          ? helper?.status === "ready"
            ? {
                title: t({ message: "Capture is ready" }),
                description: t({ message: "Next, choose your shortcut." }),
              }
            : helper?.status === "error"
              ? {
                  title: t({ message: "Let's fix capture access" }),
                  description: t({
                    message: "Try reinstalling the capture helper, then check again.",
                  }),
                }
              : {
                  title:
                    helper?.status === "update-required"
                      ? t({ message: "Update the capture helper" })
                      : t({ message: "Allow snapshots" }),
                  description: t({
                    message:
                      "T3 Code's capture helper lets you capture other apps and return to your draft. It's included with T3 Code.",
                  }),
                }
          : backend === "niri"
            ? {
                title: t({ message: "Capture is ready" }),
                description: t({ message: "Next, choose your shortcut." }),
              }
            : backend === "picker"
              ? {
                  title: t({ message: "Choose a window each time" }),
                  description: t({
                    message:
                      "Your desktop doesn't support automatic capture. You'll choose the window to capture instead.",
                  }),
                }
              : {
                  title: t({ message: "Allow snapshots" }),
                  description:
                    backend === "portal"
                      ? t({
                          message: "Your desktop may ask for permission when you first capture.",
                        })
                      : macPermissions
                        ? macPermissionsReady
                          ? t({
                              message:
                                "Test a snapshot of the current window. If macOS asks to bypass its window picker, choose Allow. The test image is discarded.",
                            })
                          : t({ message: "Allow each permission, then continue." })
                        : t({ message: "Allow access when prompted to start capturing windows." }),
                };
  const title = step === "access" ? accessCopy.title : t({ message: "Choose your shortcut" });
  const description =
    step === "access"
      ? accessCopy.description
      : configShortcut
        ? t({ message: "Click the shortcut, then press the keys you want." })
        : state.mode === "portal"
          ? t({ message: "Choose your keys, then approve the permission prompt if asked." })
          : t({ message: "Use both Shift keys, or record a different shortcut." });
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
        <WizardHeader
          title={desktop ? t`Set up snapshots for ${desktop}` : t({ message: "Set up snapshots" })}
        >
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
                  <PermissionChecklist
                    busy={busy}
                    permissions={[
                      {
                        id: "screenRecording",
                        icon: <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t({ message: "Screen Recording" }),
                        description: t({ message: "Capture the window you're using." }),
                        granted: macPermissions.screenRecording,
                        onAllow: () => void onAction("allow-screen-recording"),
                      },
                      {
                        id: "accessibility",
                        icon: <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t({ message: "Accessibility" }),
                        description: includeAccessibility
                          ? t({ message: "Include text and controls from the captured app." })
                          : t({
                              message: "Optional. Include text and controls from the captured app.",
                            }),
                        granted: macPermissions.accessibility,
                        onAllow: () => void onAction("allow-accessibility"),
                      },
                    ]}
                  />
                ) : null}
                {permissionStatus.error && macPermissions ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    {permissionStatus.error}
                  </p>
                ) : null}
                {helperBackend && helper?.status === "error" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void onAction(installHelper)}
                  >
                    <Trans>Reinstall helper</Trans>
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
                    {state.mode === "portal" ? (
                      <Trans>Shortcut permissions</Trans>
                    ) : (
                      <Trans>Try again</Trans>
                    )}
                  </Button>
                ) : null}
              </div>
            )}
            {step === "shortcut" && !accessReady ? (
              <p role="alert" className="text-destructive">
                <Trans>Capture needs attention. Go back to check access.</Trans>
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                <Trans>Couldn't finish this step. Try again or check Advanced for help.</Trans>
              </p>
            ) : null}
            {details.length > 0 || (step === "access" && (backend === "gnome" || helperBackend)) ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  <Trans>Advanced</Trans>
                </summary>
                <div className="mt-3 space-y-3">
                  {details.map((detail) => (
                    <p key={detail} className="break-words">
                      {detail}
                    </p>
                  ))}
                  {step === "access" && (backend === "gnome" || helperBackend) ? (
                    <p>
                      <Trans>Included with T3 Code. No download needed.</Trans>
                    </p>
                  ) : null}
                  {step === "access" && backend === "gnome" && extension?.status === "enabled" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction("disable-extension")}
                    >
                      <Trans>Disable extension</Trans>
                    </Button>
                  ) : null}
                  {step === "access" && helperBackend && helper?.status !== "not-installed" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction(removeHelper)}
                    >
                      <Trans>Remove capture helper</Trans>
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
              <Trans>Back</Trans>
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={() => void onClose(false)}>
            {wasEnabled ? <Trans>Close</Trans> : <Trans>Finish later</Trans>}
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
                {checking ? (
                  <Trans>Checking…</Trans>
                ) : busy ? (
                  <Trans>Installing…</Trans>
                ) : helper?.status === "error" ? (
                  <Trans>Check again</Trans>
                ) : helper?.status === "update-required" ? (
                  <Trans>Update helper</Trans>
                ) : (
                  <Trans>Install helper</Trans>
                )}
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
                {checking ? (
                  <Trans>Checking…</Trans>
                ) : busy ? (
                  install ? (
                    <Trans>Installing…</Trans>
                  ) : enable ? (
                    <Trans>Enabling…</Trans>
                  ) : (
                    <Trans>Working…</Trans>
                  )
                ) : install ? (
                  extension?.status === "update-required" ? (
                    <Trans>Update extension</Trans>
                  ) : (
                    <Trans>Install extension</Trans>
                  )
                ) : enable ? (
                  <Trans>Enable extension</Trans>
                ) : (
                  <Trans>Check again</Trans>
                )}
              </Button>
            ) : (
              <PermissionContinueButton
                ready={macPermissionsReady}
                busy={busy}
                onClick={async () => {
                  if (await onEnable()) changeStep("shortcut");
                }}
              >
                {busy ? (
                  <Trans>Working…</Trans>
                ) : macPermissions ? (
                  <Trans>Test capture and continue</Trans>
                ) : backend === "direct" ? (
                  <Trans>Allow capture</Trans>
                ) : !accessReady && !macPermissions ? (
                  <Trans>Try again</Trans>
                ) : (
                  <Trans>Continue</Trans>
                )}
              </PermissionContinueButton>
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
              {busy ? (
                <Trans>Saving…</Trans>
              ) : shortcutChanged ? (
                <Trans>Save and finish</Trans>
              ) : (
                <Trans>Done</Trans>
              )}
            </Button>
          ) : null}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
