import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isModifierPairShortcut,
  type ClientSettingsPatch,
  type DesktopSnapShotShortcutAvailability,
  type DesktopSnapShotSetupAction,
  type SnapShotShortcut,
} from "@t3tools/contracts";
import { CameraIcon } from "lucide-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useContext, useRef, useState } from "react";
import { T, useGT, useMessages } from "gt-react";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import {
  saveSnapShotSetupResume,
  clearSnapShotSetupResume,
  readSnapShotSetupResume,
} from "../../lib/snapShotSetupResume";
import { sameSnapShotShortcut, snapShotKeybindingConflict } from "../../lib/snapShotShortcut";
import { playSnapShotSound } from "../../lib/snapShotSound";
import {
  desktopSnapShotAtom,
  refreshDesktopSnapShotState,
  snapShotSetupError,
  type SnapShotSetupError,
} from "../../state/desktopSnapShot";
import { toastManager } from "../ui/toast";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { commandLabel } from "./KeybindingsSettings.logic";
import {
  snapShotStatus,
  snapShotShortcutStatus,
  snapShotSetupButtonLabel,
  snapShotUnavailableMessage,
  snapShotSoundPatch,
  snapShotFeedbackUnavailableMessage,
  snapShotDescription,
  snapShotAccessibilityUnavailableMessage,
  snapShotSetupComplete,
  snapShotCaptureHelperStatus,
  type SnapShotSoundSelection,
} from "./SnapShotSettings.logic";
import {
  SettingsUnavailableGroup,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Switch } from "../ui/switch";
import { SnapShotSetupDialog } from "./SnapShotSetupDialog";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";
import {
  captureSetupAccessReady,
  captureSetupInitialStep,
  captureSetupShouldDisableOnClose,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";

type ShortcutCheck =
  | { readonly status: "idle"; readonly availability: null }
  | {
      readonly status: "checking";
      readonly availability: null;
      readonly shortcut: SnapShotShortcut;
      readonly savedShortcut: SnapShotShortcut;
    }
  | {
      readonly status: "checked";
      readonly shortcut: SnapShotShortcut;
      readonly savedShortcut: SnapShotShortcut;
      readonly availability: DesktopSnapShotShortcutAvailability;
    };

export function SnapShotSettings() {
  const messages = useMessages();
  const setting = useSearchableSetting();
  const gt = useGT();
  const settings = useClientSettings((current) => ({
    snapShotAnimations: current.snapShotAnimations,
    snapShotEnabled: current.snapShotEnabled,
    snapShotFlash: current.snapShotFlash,
    snapShotIncludeAccessibility: current.snapShotIncludeAccessibility,
    snapShotPlaySound: current.snapShotPlaySound,
    snapShotShortcut: current.snapShotShortcut,
    snapShotSound: current.snapShotSound,
  }));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const bridge = getDesktopSnapShotBridge();
  const registry = useContext(RegistryContext);
  const { state, refreshError } = useAtomValue(desktopSnapShotAtom);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<SnapShotSetupError | null>(null);
  // macOS can quit the app from a permission prompt; until the user opens or closes the wizard
  // themselves, a saved resume reopens it where it left off.
  const [resume] = useState(readSnapShotSetupResume);
  const [chosenWizard, setWizard] = useState<{
    initialStep: CaptureSetupStep;
    wasEnabled: boolean;
  } | null>();
  const wizard =
    chosenWizard !== undefined
      ? chosenWizard
      : state?.macPermissions && resume
        ? { initialStep: "access" as const, wasEnabled: resume.wasEnabled }
        : null;
  // The wizard shows errors inline; outside it there is nowhere to, so they become a toast.
  const reportSetupError = (title: string, error: unknown) => {
    const report = snapShotSetupError(title, error);
    setSetupError(report);
    if (!wizard)
      toastManager.add({ type: "error", title: report.title, description: report.message });
  };
  const refreshState = () =>
    refreshDesktopSnapShotState(registry, (error) =>
      reportSetupError(gt("Couldn't check capture setup"), error),
    );
  const [candidate, setCandidate] = useState<SnapShotShortcut>(settings.snapShotShortcut);
  const [latestShortcutCheck, setShortcutCheck] = useState<ShortcutCheck>({
    status: "idle",
    availability: null,
  });
  // A check answers for one candidate against one saved shortcut. Once either moves on (an edit,
  // or hydration saving a new shortcut) a late answer no longer shows, so a check for the
  // shortcut that just got saved can't claim it is ready to save.
  const savedShortcut = settings.snapShotShortcut;
  const shortcutCheck: ShortcutCheck =
    latestShortcutCheck.status === "idle" ||
    (sameSnapShotShortcut(latestShortcutCheck.shortcut, candidate) &&
      sameSnapShotShortcut(latestShortcutCheck.savedShortcut, savedShortcut))
      ? latestShortcutCheck
      : { status: "idle", availability: null };
  const shortcutCheckIdRef = useRef(0);
  const unavailableMessage = snapShotUnavailableMessage(Boolean(bridge), messages);
  // In a browser there is nothing to update: say where snapshots live instead of warning.
  const webOnly = !bridge && !(typeof window !== "undefined" && window.desktopBridge);
  const captureAvailable = Boolean(bridge) && state !== null && state.mode !== "unavailable";
  const feedbackUnavailable = snapShotFeedbackUnavailableMessage(state, messages);
  const captureHelper = snapShotCaptureHelperStatus(state, messages);
  const managedShortcut = state?.linuxBackend === "niri" || state?.linuxBackend === "hyprland";
  const shortcutChanged = !managedShortcut && !sameSnapShotShortcut(candidate, savedShortcut);
  const displayShortcut = shortcutChanged ? candidate : (state?.shortcut ?? savedShortcut);
  const candidateConflict = shortcutChanged
    ? snapShotKeybindingConflict(candidate, keybindings)
    : null;
  const canSaveShortcut =
    shortcutChanged && candidateConflict === null && shortcutCheck.availability?.available === true;
  const soundSelection = settings.snapShotPlaySound ? settings.snapShotSound : "off";
  const soundLabel =
    soundSelection === "off"
      ? gt("Off", { $context: "snapshot sound turned off" })
      : soundSelection === "soft-pop"
        ? gt("Whoosh (Default)")
        : gt("Click", { $context: "name of a camera-shutter sound" });

  const setup = async (action: DesktopSnapShotSetupAction) => {
    if (!bridge || setupBusy) return;
    setSetupBusy(true);
    setSetupError(null);
    const result = await settlePromise(async () => {
      if (
        state?.macPermissions &&
        wizard &&
        (action === "allow-screen-recording" || action === "allow-accessibility")
      ) {
        // macOS can quit the app from its permission prompt.
        saveSnapShotSetupResume(wizard.wasEnabled);
      }
      await bridge.setupSnapShot(action);
      await refreshState();
    });
    if (result._tag === "Failure") {
      reportSetupError(
        action === "retry-shortcut"
          ? gt("Couldn't open shortcut permissions")
          : gt("Couldn't complete capture setup"),
        Cause.squash(result.cause),
      );
    }
    setSetupBusy(false);
  };

  // Hydration can hand back an equal shortcut object; only a different shortcut resets the edit.
  const [renderedSavedShortcut, setRenderedSavedShortcut] = useState(savedShortcut);
  if (!sameSnapShotShortcut(renderedSavedShortcut, savedShortcut)) {
    setRenderedSavedShortcut(savedShortcut);
    setCandidate(savedShortcut);
    setShortcutCheck({ status: "idle", availability: null });
  }

  const save = async (patch: ClientSettingsPatch) => {
    setSetupError(null);
    try {
      await updateClientSettings(patch);
      return await refreshState();
    } catch (error) {
      reportSetupError(gt("Couldn't save capture settings"), error);
    }
  };

  const saveIncludeAccessibility = async (includeAccessibility: boolean) => {
    try {
      if (includeAccessibility && settings.snapShotEnabled)
        await bridge?.requestSnapShotPermissions(true);
      await save({ snapShotIncludeAccessibility: includeAccessibility });
    } catch (error) {
      reportSetupError(gt("Couldn't allow app text capture"), error);
    }
  };

  const checkShortcut = async (shortcut: SnapShotShortcut) => {
    const checkId = ++shortcutCheckIdRef.current;
    setCandidate(shortcut);
    const conflict = snapShotKeybindingConflict(shortcut, keybindings);
    if (conflict || !bridge) return;
    setShortcutCheck({ status: "checking", availability: null, shortcut, savedShortcut });
    try {
      const availability = await bridge.checkSnapShotShortcut(shortcut);
      if (checkId === shortcutCheckIdRef.current) {
        setShortcutCheck({ status: "checked", availability, shortcut, savedShortcut });
      }
    } catch (error) {
      if (checkId !== shortcutCheckIdRef.current) return;
      setShortcutCheck({
        status: "checked",
        shortcut,
        savedShortcut,
        availability: {
          available: false,
          message:
            error instanceof Error
              ? (thrownErrorMessage(error, m) ?? error.message)
              : gt("Could not check this shortcut."),
        },
      });
    }
  };

  const {
    recording,
    stopRecording,
    input: shortcutInput,
  } = useSnapShotShortcutRecorder({
    shortcut: displayShortcut,
    shortcutLabel: !shortcutChanged ? state?.shortcutLabel : undefined,
    disabled: setupBusy,
    allowModifierPairs: state?.mode !== "portal",
    onRecord: (shortcut) => void checkShortcut(shortcut),
    onStart: () => {
      shortcutCheckIdRef.current++;
      setShortcutCheck({ status: "idle", availability: null });
    },
    onError: (message) =>
      setShortcutCheck({
        status: "checked",
        shortcut: candidate,
        savedShortcut,
        availability: { available: false, message },
      }),
  });

  const shortcutStatus = recording
    ? gt("Press your shortcut. Esc cancels.")
    : candidateConflict
      ? gt('T3 Code already uses this for "{command}".', {
          command: commandLabel(candidateConflict, messages),
        })
      : shortcutCheck.status === "checking"
        ? gt("Checking shortcut…")
        : shortcutCheck.availability
          ? shortcutCheck.availability.available
            ? gt("Ready to save.")
            : shortcutCheck.availability.message
          : state?.mode === "portal" &&
              !state.shortcutLabel &&
              isModifierPairShortcut(displayShortcut)
            ? gt("Try a shortcut such as Ctrl+Shift+2.")
            : snapShotShortcutStatus(state, messages);

  const openSetup = async (requested: CaptureSetupStep | "resume" = "resume") => {
    if (!state || setupBusy) return;
    stopRecording();
    shortcutCheckIdRef.current++;
    setCandidate(savedShortcut);
    setShortcutCheck({ status: "idle", availability: null });
    setSetupError(null);
    setSetupBusy(true);
    await prepareSetup(requested).finally(() => setSetupBusy(false));
  };

  const prepareSetup = async (requested: CaptureSetupStep | "resume") => {
    let current = await refreshState();
    if (!current) return;
    if (current.macPermissions) requested = "access";
    if (!settings.snapShotEnabled && captureSetupInitialStep(current, requested) !== "access") {
      current = await save({ snapShotEnabled: true });
      if (!current) {
        // Settings may save before status checking fails; keep Finish later available to disable capture.
        setWizard({ initialStep: "access", wasEnabled: false });
        return;
      }
    }
    setWizard({
      initialStep: captureSetupInitialStep(current, requested),
      wasEnabled: settings.snapShotEnabled,
    });
  };

  const enableForSetup = async () => {
    if (setupBusy) return false;
    setSetupBusy(true);
    setSetupError(null);
    const verified = await settlePromise(async () => {
      if (state?.macPermissions) {
        saveSnapShotSetupResume(wizard?.wasEnabled ?? settings.snapShotEnabled);
        await bridge?.setupSnapShot("test-mac-capture");
      }
      if (state?.mode === "direct")
        await bridge?.requestSnapShotPermissions(settings.snapShotIncludeAccessibility);
      const nextState =
        settings.snapShotEnabled && !state?.message
          ? await refreshState()
          : await save({ snapShotEnabled: true });
      return nextState !== undefined && captureSetupAccessReady(nextState);
    });
    setSetupBusy(false);
    if (verified._tag === "Success") return verified.value;
    reportSetupError(gt("Couldn't verify capture access"), Cause.squash(verified.cause));
    return false;
  };

  const closeSetup = async (completed: boolean) => {
    if (!wizard || setupBusy) return;
    setSetupBusy(true);
    const closed = await settlePromise(async () => {
      if (
        settings.snapShotEnabled &&
        captureSetupShouldDisableOnClose(wizard.wasEnabled, completed)
      ) {
        if (!(await save({ snapShotEnabled: false }))) return;
      }
      stopRecording();
      setSetupError(null);
      clearSnapShotSetupResume();
      setWizard(null);
    });
    if (closed._tag === "Failure") {
      reportSetupError(gt("Couldn't close capture setup"), Cause.squash(closed.cause));
    }
    setSetupBusy(false);
  };

  const saveShortcut = async () => {
    if (!canSaveShortcut || setupBusy) return false;
    setSetupBusy(true);
    const saved = await save({ snapShotShortcut: candidate }).finally(() => setSetupBusy(false));
    return Boolean(saved?.shortcutRegistered || saved?.shortcutPending);
  };

  return (
    <SettingsPageContainer>
      {webOnly ? (
        <SettingsSection title={gt("Desktop app")} hideTitle>
          <SettingsRow
            leading={<CameraIcon />}
            title={gt("SnapShots run in the desktop app")}
            description={gt("Capture any window with a shortcut and drop it into your draft.")}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection
        id="snap-shot"
        title={gt("Capture", { $context: "settings section for window snapshots" })}
        warning={webOnly ? undefined : unavailableMessage}
      >
        <SettingsUnavailableGroup unavailable={!webOnly && unavailableMessage !== undefined}>
          <SettingsRow
            {...setting("snap-shot-enabled")}
            description={snapShotDescription(state, messages)}
            status={
              bridge
                ? setupBusy && !wizard
                  ? gt("Updating capture settings…")
                  : refreshError
                    ? `${refreshError.title}. ${refreshError.message}`
                    : snapShotStatus(state, settings.snapShotEnabled, messages)
                : undefined
            }
            control={
              <>
                {settings.snapShotEnabled &&
                !snapShotSetupComplete(state, settings.snapShotIncludeAccessibility) ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={setupBusy}
                    onClick={() => void openSetup()}
                  >
                    {snapShotSetupButtonLabel(state, messages)}
                  </Button>
                ) : null}
                <Switch
                  checked={settings.snapShotEnabled || Boolean(wizard)}
                  disabled={!captureAvailable || setupBusy}
                  aria-label={gt("Enable snapshots")}
                  onCheckedChange={(checked) => {
                    if (!checked) void save({ snapShotEnabled: false });
                    else if (state?.windows) void save({ snapShotEnabled: true });
                    else void openSetup();
                  }}
                />
              </>
            }
          />
          {settings.snapShotEnabled && captureAvailable ? (
            <>
              <SettingsRow
                {...setting("snap-shot-shortcut")}
                description={
                  state?.linuxBackend === "picker"
                    ? gt("Choose a window to capture from any app.")
                    : gt("Capture the window you're using without switching apps.")
                }
                status={managedShortcut ? undefined : shortcutStatus}
                control={
                  managedShortcut ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={setupBusy}
                      onClick={() => void openSetup("shortcut")}
                    >
                      <T>Change shortcut</T>
                    </Button>
                  ) : (
                    <>
                      {shortcutInput}
                      {shortcutChanged ? (
                        <>
                          <Button
                            size="xs"
                            disabled={!canSaveShortcut || setupBusy}
                            onClick={() => void saveShortcut()}
                          >
                            {setupBusy ? gt("Saving…") : gt("Save")}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={setupBusy}
                            onClick={() => {
                              stopRecording();
                              shortcutCheckIdRef.current++;
                              setCandidate(savedShortcut);
                              setShortcutCheck({ status: "idle", availability: null });
                            }}
                          >
                            <T>Cancel</T>
                          </Button>
                        </>
                      ) : state?.mode === "portal" &&
                        state.shortcutCanRetry !== false &&
                        !isModifierPairShortcut(savedShortcut) ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={setupBusy || state.shortcutPending}
                          onClick={() => void setup("retry-shortcut")}
                        >
                          <T>Shortcut permissions</T>
                        </Button>
                      ) : null}
                    </>
                  )
                }
              />
              <SettingsRow
                {...setting("snap-shot-accessibility")}
                description={gt("Include text and controls when the app makes them available.")}
                status={snapShotAccessibilityUnavailableMessage(state, messages)}
                control={
                  <Switch
                    checked={
                      !snapShotAccessibilityUnavailableMessage(state, messages) &&
                      settings.snapShotIncludeAccessibility
                    }
                    disabled={
                      !captureAvailable ||
                      Boolean(snapShotAccessibilityUnavailableMessage(state, messages))
                    }
                    aria-label={gt("Include app text in snapshots")}
                    onCheckedChange={(checked) => void saveIncludeAccessibility(checked)}
                  />
                }
              />
            </>
          ) : null}
        </SettingsUnavailableGroup>
      </SettingsSection>
      {settings.snapShotEnabled && captureAvailable && unavailableMessage === undefined ? (
        <SettingsSection
          id="snap-shot-feedback"
          title={gt("Feedback", { $context: "settings section" })}
        >
          <SettingsRow
            {...setting("snap-shot-sound")}
            description={gt("Choose the sound played when capture starts.")}
            control={
              <ToggleGroup
                aria-label={gt("Snapshot sound: {sound}", { sound: soundLabel })}
                value={[soundSelection]}
                disabled={!captureAvailable}
                onValueChange={(values) => {
                  const next = values[0] as SnapShotSoundSelection | undefined;
                  if (!next || next === soundSelection) return;
                  // Choosing a sound previews it, replacing the old menu's play buttons.
                  if (next !== "off") playSnapShotSound(next);
                  void save(snapShotSoundPatch(next));
                }}
              >
                <Toggle value="soft-pop">
                  {gt("Whoosh", { $context: "name of a whoosh sound" })}
                </Toggle>
                <Toggle value="camera-shutter">
                  {gt("Click", { $context: "name of a camera-shutter sound" })}
                </Toggle>
                <Toggle value="off">{gt("None", { $context: "no snapshot sound" })}</Toggle>
              </ToggleGroup>
            }
          />
          <SettingsRow
            {...setting("snap-shot-flash")}
            description={gt("Show a gentle cue on the captured window.")}
            status={feedbackUnavailable}
            control={
              <Switch
                checked={!feedbackUnavailable && settings.snapShotFlash}
                disabled={!captureAvailable || Boolean(feedbackUnavailable)}
                aria-label={gt("Flash captured window")}
                onCheckedChange={(checked) => void save({ snapShotFlash: checked })}
              />
            }
          />
          <SettingsRow
            {...setting("snap-shot-animations")}
            description={gt("Animate captured windows into your draft.")}
            status={feedbackUnavailable}
            control={
              <Switch
                checked={!feedbackUnavailable && settings.snapShotAnimations}
                disabled={!captureAvailable || Boolean(feedbackUnavailable)}
                aria-label={gt("Animate snapshots")}
                onCheckedChange={(checked) => void save({ snapShotAnimations: checked })}
              />
            }
          />
        </SettingsSection>
      ) : null}
      {settings.snapShotEnabled && captureHelper && unavailableMessage === undefined ? (
        <SettingsSection
          id="snap-shot-advanced"
          title={gt("Advanced", { $context: "settings section" })}
        >
          <SettingsRow
            title={gt("Capture helper")}
            description={captureHelper.description}
            control={
              <>
                {captureHelper.needsSetup ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={setupBusy}
                    onClick={() => void openSetup("access")}
                  >
                    <T>Set up</T>
                  </Button>
                ) : null}
                <Badge variant={captureHelper.tone}>{captureHelper.label}</Badge>
              </>
            }
          />
        </SettingsSection>
      ) : null}
      {wizard && state ? (
        <SnapShotSetupDialog
          state={state}
          initialStep={wizard.initialStep}
          wasEnabled={wizard.wasEnabled}
          includeAccessibility={settings.snapShotIncludeAccessibility}
          busy={setupBusy}
          error={(setupError ?? refreshError)?.message ?? null}
          shortcutInput={shortcutInput}
          shortcutStatus={shortcutStatus}
          shortcutChanged={shortcutChanged}
          canSaveShortcut={canSaveShortcut}
          onSaveShortcut={saveShortcut}
          onEnable={enableForSetup}
          onAction={setup}
          onRefresh={refreshState}
          onClose={closeSetup}
          onLeaveStep={stopRecording}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
