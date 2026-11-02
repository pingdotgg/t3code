import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import {
  isModifierPairShortcut,
  type DesktopSnapShotSetupAction,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { useState, type ReactNode } from "react";
import { useT } from "../../hooks/useI18n";
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
  { id: "access", label: "settings.providers.snapshot.setup.step.access" },
  { id: "shortcut", label: "settings.providers.snapshot.setup.step.shortcut" },
] as const satisfies ReadonlyArray<{ id: string; label: MessageKey }>;

const GNOME_ACCESS_COPY: Record<string, { title: MessageKey; description: MessageKey }> = {
  "not-installed": {
    title: "settings.providers.snapshot.setup.gnome.notInstalled.title",
    description: "settings.providers.snapshot.setup.gnome.notInstalled.description",
  },
  "restart-required": {
    title: "settings.providers.snapshot.setup.gnome.restartRequired.title",
    description: "settings.providers.snapshot.setup.gnome.restartRequired.description",
  },
  "update-required": {
    title: "settings.providers.snapshot.setup.gnome.updateRequired.title",
    description: "settings.providers.snapshot.setup.gnome.updateRequired.description",
  },
  "extensions-disabled": {
    title: "settings.providers.snapshot.setup.gnome.extensionsDisabled.title",
    description: "settings.providers.snapshot.setup.gnome.extensionsDisabled.description",
  },
  disabled: {
    title: "settings.providers.snapshot.setup.gnome.disabled.title",
    description: "settings.providers.snapshot.setup.gnome.disabled.description",
  },
  enabled: {
    title: "settings.providers.snapshot.setup.captureReady",
    description: "settings.providers.snapshot.setup.nextShortcut",
  },
  unsupported: {
    title: "settings.providers.snapshot.setup.gnome.unsupported.title",
    description: "settings.providers.snapshot.setup.gnome.unsupported.description",
  },
  error: {
    title: "settings.providers.snapshot.setup.gnome.error.title",
    description: "settings.providers.snapshot.setup.gnome.error.description",
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
  const t = useT();
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
      if (!refreshed?.macPermissions)
        throw new Error(t("settings.providers.snapshot.setup.permissionUnavailable"));
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
  const accessCopy: { title: MessageKey; description: MessageKey } =
    state.message && !macPermissions
      ? {
          title: "settings.providers.snapshot.setup.retry.title",
          description: "settings.providers.snapshot.setup.retry.description",
        }
      : backend === "gnome" && extension
        ? extension.status === "enabled" && !accessReady
          ? {
              title: "settings.providers.snapshot.setup.checkAccess.title",
              description: "settings.providers.snapshot.setup.checkAccess.description",
            }
          : (GNOME_ACCESS_COPY[extension.status] ?? GNOME_ACCESS_COPY.error!)
        : helperBackend
          ? helper?.status === "ready"
            ? {
                title: "settings.providers.snapshot.setup.captureReady",
                description: "settings.providers.snapshot.setup.nextShortcut",
              }
            : helper?.status === "error"
              ? {
                  title: "settings.providers.snapshot.setup.fixAccess.title",
                  description: "settings.providers.snapshot.setup.fixAccess.description",
                }
              : {
                  title:
                    helper?.status === "update-required"
                      ? "settings.providers.snapshot.setup.updateHelper.title"
                      : "settings.providers.snapshot.setup.allow.title",
                  description: "settings.providers.snapshot.setup.helper.description",
                }
          : backend === "niri"
            ? {
                title: "settings.providers.snapshot.setup.captureReady",
                description: "settings.providers.snapshot.setup.nextShortcut",
              }
            : backend === "picker"
              ? {
                  title: "settings.providers.snapshot.setup.picker.title",
                  description: "settings.providers.snapshot.setup.picker.description",
                }
              : {
                  title: "settings.providers.snapshot.setup.allow.title",
                  description:
                    backend === "portal"
                      ? "settings.providers.snapshot.setup.portal.description"
                      : macPermissions
                        ? macPermissionsReady
                          ? "settings.providers.snapshot.setup.mac.test"
                          : "settings.providers.snapshot.setup.mac.allow"
                        : "settings.providers.snapshot.setup.allowAccess.description",
                };
  const title =
    step === "access" ? t(accessCopy.title) : t("settings.providers.snapshot.setup.shortcut.title");
  const description =
    step === "access"
      ? t(accessCopy.description)
      : configShortcut
        ? t("settings.providers.snapshot.setup.shortcut.configDescription")
        : state.mode === "portal"
          ? t("settings.providers.snapshot.setup.shortcut.portalDescription")
          : t("settings.providers.snapshot.setup.shortcut.shiftDescription");
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
              ? t("settings.providers.snapshot.setup.titleDesktop", { desktop })
              : t("settings.providers.snapshot.setup.title")
          }
        >
          <WizardSteps
            steps={SETUP_STEPS.map((item) => t(item.label))}
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
                  {checked && !busy && !error ? captureSetupCheckMessage(state, t) : null}
                </p>
                {macPermissions ? (
                  <PermissionChecklist
                    busy={busy}
                    permissions={[
                      {
                        id: "screenRecording",
                        icon: <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t("settings.providers.snapshot.setup.mac.screenRecording"),
                        description: t(
                          "settings.providers.snapshot.setup.mac.screenRecordingDescription",
                        ),
                        granted: macPermissions.screenRecording,
                        onAllow: () => void onAction("allow-screen-recording"),
                      },
                      {
                        id: "accessibility",
                        icon: <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />,
                        title: t("settings.providers.snapshot.setup.mac.accessibility"),
                        description: includeAccessibility
                          ? t("settings.providers.snapshot.setup.mac.accessibilityIncluded")
                          : t("settings.providers.snapshot.setup.mac.accessibilityOptional"),
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
                    {t("settings.providers.snapshot.setup.reinstallHelper")}
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
                      ? t("settings.providers.snapshot.shortcutPermissions")
                      : t("settings.providers.snapshot.setup.tryAgain")}
                  </Button>
                ) : null}
              </div>
            )}
            {step === "shortcut" && !accessReady ? (
              <p role="alert" className="text-destructive">
                {t("settings.providers.snapshot.setup.needsAttention")}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {t("settings.providers.snapshot.setup.stepError")}
              </p>
            ) : null}
            {details.length > 0 || (step === "access" && (backend === "gnome" || helperBackend)) ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t("settings.layout.advanced")}</summary>
                <div className="mt-3 space-y-3">
                  {details.map((detail) => (
                    <p key={detail} className="break-words">
                      {detail}
                    </p>
                  ))}
                  {step === "access" && (backend === "gnome" || helperBackend) ? (
                    <p>{t("settings.providers.snapshot.setup.included")}</p>
                  ) : null}
                  {step === "access" && backend === "gnome" && extension?.status === "enabled" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction("disable-extension")}
                    >
                      {t("settings.providers.snapshot.setup.disableExtension")}
                    </Button>
                  ) : null}
                  {step === "access" && helperBackend && helper?.status !== "not-installed" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onAction(removeHelper)}
                    >
                      {t("settings.providers.snapshot.setup.removeHelper")}
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
              {t("settings.providers.snapshot.setup.back")}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={() => void onClose(false)}>
            {wasEnabled
              ? t("settings.providers.snapshot.setup.close")
              : t("settings.providers.snapshot.setup.finishLater")}
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
                  ? t("settings.providers.snapshot.setup.checking")
                  : busy
                    ? t("settings.providers.snapshot.setup.installing")
                    : helper?.status === "error"
                      ? t("settings.providers.snapshot.setup.checkAgain")
                      : helper?.status === "update-required"
                        ? t("settings.providers.snapshot.setup.updateHelperButton")
                        : t("settings.providers.snapshot.setup.installHelper")}
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
                  ? t("settings.providers.snapshot.setup.checking")
                  : busy
                    ? install
                      ? t("settings.providers.snapshot.setup.installing")
                      : enable
                        ? t("settings.providers.snapshot.setup.enabling")
                        : t("settings.providers.snapshot.setup.working")
                    : install
                      ? extension?.status === "update-required"
                        ? t("settings.providers.snapshot.setup.updateExtension")
                        : t("settings.providers.snapshot.setup.installExtension")
                      : enable
                        ? t("settings.providers.snapshot.setup.enableExtension")
                        : t("settings.providers.snapshot.setup.checkAgain")}
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
                  ? t("settings.providers.snapshot.setup.working")
                  : macPermissions
                    ? t("settings.providers.snapshot.setup.testCapture")
                    : backend === "direct"
                      ? t("settings.providers.snapshot.setup.allowCapture")
                      : !accessReady && !macPermissions
                        ? t("settings.providers.snapshot.setup.tryAgain")
                        : t("settings.providers.snapshot.setup.continue")}
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
                ? t("settings.providers.snapshot.saving")
                : shortcutChanged
                  ? t("settings.providers.snapshot.setup.saveFinish")
                  : t("settings.providers.snapshot.config.done")}
            </Button>
          ) : null}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
