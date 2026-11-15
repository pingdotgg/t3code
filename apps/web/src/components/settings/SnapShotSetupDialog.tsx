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
import { useTranslation } from "react-i18next";
import { translateDynamic } from "../../i18nCore";
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
  { id: "access", labelKey: "snapShotSetup.stepAccess" },
  { id: "shortcut", labelKey: "snapShotSetup.stepShortcut" },
] as const;

const GNOME_ACCESS_COPY = {
  "not-installed": {
    titleKey: "snapShotSetup.gnome.notInstalledTitle",
    descriptionKey: "snapShotSetup.gnome.notInstalledDescription",
  },
  "restart-required": {
    titleKey: "snapShotSetup.gnome.restartRequiredTitle",
    descriptionKey: "snapShotSetup.gnome.restartRequiredDescription",
  },
  "update-required": {
    titleKey: "snapShotSetup.gnome.updateRequiredTitle",
    descriptionKey: "snapShotSetup.gnome.updateRequiredDescription",
  },
  "extensions-disabled": {
    titleKey: "snapShotSetup.gnome.extensionsDisabledTitle",
    descriptionKey: "snapShotSetup.gnome.extensionsDisabledDescription",
  },
  disabled: {
    titleKey: "snapShotSetup.gnome.disabledTitle",
    descriptionKey: "snapShotSetup.gnome.disabledDescription",
  },
  enabled: {
    titleKey: "snapShotSetup.gnome.enabledTitle",
    descriptionKey: "snapShotSetup.gnome.enabledDescription",
  },
  unsupported: {
    titleKey: "snapShotSetup.gnome.unsupportedTitle",
    descriptionKey: "snapShotSetup.gnome.unsupportedDescription",
  },
  error: {
    titleKey: "snapShotSetup.gnome.errorTitle",
    descriptionKey: "snapShotSetup.gnome.errorDescription",
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
  const { t } = useTranslation("settings");
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
          title: t("snapShotSetup.retryTitle"),
          description: t("snapShotSetup.retryDescription"),
        }
      : backend === "gnome" && extension
        ? extension.status === "enabled" && !accessReady
          ? {
              title: t("snapShotSetup.checkAccessTitle"),
              description: t("snapShotSetup.checkAccessDescription"),
            }
          : {
              title: translateDynamic(`settings:${GNOME_ACCESS_COPY[extension.status].titleKey}`),
              description: translateDynamic(
                `settings:${GNOME_ACCESS_COPY[extension.status].descriptionKey}`,
              ),
            }
        : helperBackend
          ? helper?.status === "ready"
            ? {
                title: t("snapShotSetup.readyTitle"),
                description: t("snapShotSetup.readyDescription"),
              }
            : helper?.status === "error"
              ? {
                  title: t("snapShotSetup.fixAccessTitle"),
                  description: t("snapShotSetup.fixAccessDescription"),
                }
              : {
                  title:
                    helper?.status === "update-required"
                      ? t("snapShotSetup.helperUpdateTitle")
                      : t("snapShotSetup.allowTitle"),
                  description: t("snapShotSetup.helperDescription"),
                }
          : backend === "niri"
            ? {
                title: t("snapShotSetup.readyTitle"),
                description: t("snapShotSetup.readyDescription"),
              }
            : backend === "picker"
              ? {
                  title: t("snapShotSetup.pickerTitle"),
                  description: t("snapShotSetup.pickerDescription"),
                }
              : {
                  title: t("snapShotSetup.allowTitle"),
                  description:
                    backend === "portal"
                      ? t("snapShotSetup.portalDescription")
                      : macPermissions
                        ? macPermissionsReady
                          ? t("snapShotSetup.macTestDescription")
                          : t("snapShotSetup.macPermissionDescription")
                        : t("snapShotSetup.promptDescription"),
                };
  const title = step === "access" ? accessCopy.title : t("snapShotSetup.shortcutTitle");
  const description =
    step === "access"
      ? accessCopy.description
      : configShortcut
        ? t("snapShotSetup.shortcutClickDescription")
        : state.mode === "portal"
          ? t("snapShotSetup.shortcutPortalDescription")
          : t("snapShotSetup.shortcutShiftDescription");
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
          title={
            desktop
              ? t("snapShotSetup.wizardTitleFor", { desktop })
              : t("snapShotSetup.wizardTitle")
          }
        >
          <WizardSteps
            steps={SETUP_STEPS.map((item) => t(item.labelKey))}
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
                  {checked && !busy && !error
                    ? translateDynamic(`settings:${captureSetupCheckMessage(state)}`)
                    : null}
                </p>
                {macPermissions ? (
                  <PermissionChecklist
                    busy={busy}
                    permissions={[
                      {
                        id: "screenRecording",
                        icon: <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t("snapShotSetup.screenRecordingTitle"),
                        description: t("snapShotSetup.screenRecordingDescription"),
                        granted: macPermissions.screenRecording,
                        onAllow: () => void onAction("allow-screen-recording"),
                      },
                      {
                        id: "accessibility",
                        icon: <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t("snapShotSetup.accessibilityTitle"),
                        description: includeAccessibility
                          ? t("snapShotSetup.accessibilityIncludedDescription")
                          : t("snapShotSetup.accessibilityOptionalDescription"),
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
                    {t("snapShotSetup.reinstallHelper")}
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
                    {state.mode === "portal"
                      ? t("snapShotSetup.shortcutPermissions")
                      : t("snapShotSetup.tryAgain")}
                  </Button>
                ) : null}
              </div>
            )}
            {step === "shortcut" && !accessReady ? (
              <p role="alert" className="text-destructive">
                {t("snapShotSetup.captureNeedsAttention")}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {t("snapShotSetup.stepError")}
              </p>
            ) : null}
            {details.length > 0 || (step === "access" && (backend === "gnome" || helperBackend)) ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t("snapShotSetup.advanced")}</summary>
                <div className="mt-3 space-y-3">
                  {details.map((detail) => (
                    <p key={detail} className="break-words">
                      {detail}
                    </p>
                  ))}
                  {step === "access" && (backend === "gnome" || helperBackend) ? (
                    <p>{t("snapShotSetup.includedNote")}</p>
                  ) : null}
                  {step === "access" && backend === "gnome" && extension?.status === "enabled" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction("disable-extension")}
                    >
                      {t("snapShotSetup.disableExtension")}
                    </Button>
                  ) : null}
                  {step === "access" && helperBackend && helper?.status !== "not-installed" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction(removeHelper)}
                    >
                      {t("snapShotSetup.removeHelper")}
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
              {t("snapShotSetup.back")}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={() => void onClose(false)}>
            {wasEnabled ? t("snapShotSetup.close") : t("snapShotSetup.finishLater")}
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
                  ? t("snapShotSetup.checking")
                  : busy
                    ? t("snapShotSetup.installing")
                    : helper?.status === "error"
                      ? t("snapShotSetup.checkAgain")
                      : helper?.status === "update-required"
                        ? t("snapShotSetup.updateHelper")
                        : t("snapShotSetup.installHelper")}
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
                  ? t("snapShotSetup.checking")
                  : busy
                    ? install
                      ? t("snapShotSetup.installing")
                      : enable
                        ? t("snapShotSetup.enabling")
                        : t("snapShotSetup.working")
                    : install
                      ? extension?.status === "update-required"
                        ? t("snapShotSetup.updateExtension")
                        : t("snapShotSetup.installExtension")
                      : enable
                        ? t("snapShotSetup.enableExtension")
                        : t("snapShotSetup.checkAgain")}
              </Button>
            ) : (
              <PermissionContinueButton
                ready={macPermissionsReady}
                busy={busy}
                onClick={async () => {
                  if (await onEnable()) changeStep("shortcut");
                }}
              >
                {busy
                  ? t("snapShotSetup.working")
                  : macPermissions
                    ? t("snapShotSetup.testCaptureAndContinue")
                    : backend === "direct"
                      ? t("snapShotSetup.allowCapture")
                      : !accessReady && !macPermissions
                        ? t("snapShotSetup.tryAgain")
                        : t("common.continue")}
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
              {busy
                ? t("snapShotSetup.saving")
                : shortcutChanged
                  ? t("snapShotSetup.saveAndFinish")
                  : t("common.done")}
            </Button>
          ) : null}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
