import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isModifierPairShortcut,
  type ClientSettingsPatch,
  type DesktopSnapShotShortcutAvailability,
  type DesktopSnapShotSetupAction,
  type SnapShotShortcut,
} from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useContext, useRef, useState } from "react";

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
  type SnapShotSoundSelection,
} from "./SnapShotSettings.logic";
import {
  SettingsUnavailableGroup,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SelectButton } from "../ui/select";
import { Switch } from "../ui/switch";
import { SnapShotSetupDialog } from "./SnapShotSetupDialog";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";
import {
  captureSetupAccessReady,
  captureSetupInitialStep,
  captureSetupShouldDisableOnClose,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";

const soundOptionRowClassName = "grid grid-cols-[1fr_auto]";

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
      reportSetupError("Couldn't check capture setup", error),
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
  const unavailableMessage = snapShotUnavailableMessage(Boolean(bridge));
  const captureAvailable = Boolean(bridge) && state !== null && state.mode !== "unavailable";
  const feedbackUnavailable = snapShotFeedbackUnavailableMessage(state);
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
    soundSelection === "off" ? "Off" : soundSelection === "soft-pop" ? "Whoosh (Default)" : "Click";

  const setup = async (action: DesktopSnapShotSetupAction) => {
    if (!bridge?.setupSnapShot || setupBusy) return;
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
      await bridge.setupSnapShot!(action);
      await refreshState();
    });
    if (result._tag === "Failure") {
      reportSetupError(
        action === "retry-shortcut"
          ? "Couldn't open shortcut permissions"
          : "Couldn't complete capture setup",
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
      reportSetupError("Couldn't save capture settings", error);
    }
  };

  const saveIncludeAccessibility = async (includeAccessibility: boolean) => {
    try {
      if (includeAccessibility && settings.snapShotEnabled)
        await bridge?.requestSnapShotPermissions(true);
      await save({ snapShotIncludeAccessibility: includeAccessibility });
    } catch (error) {
      reportSetupError("Couldn't allow app text capture", error);
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
          message: error instanceof Error ? error.message : "Could not check this shortcut.",
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
    ? "Press your shortcut. Esc cancels."
    : candidateConflict
      ? `T3 Code already uses this for "${commandLabel(candidateConflict)}".`
      : shortcutCheck.status === "checking"
        ? "Checking shortcut…"
        : shortcutCheck.availability
          ? shortcutCheck.availability.available
            ? "Ready to save."
            : shortcutCheck.availability.message
          : state?.mode === "portal" &&
              !state.shortcutLabel &&
              isModifierPairShortcut(displayShortcut)
            ? "Try a shortcut such as Ctrl+Shift+2."
            : snapShotShortcutStatus(state);

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
        if (!bridge?.setupSnapShot) throw new Error("Restart T3 Code to finish capture setup.");
        await bridge.setupSnapShot("test-mac-capture");
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
    reportSetupError("Couldn't verify capture access", Cause.squash(verified.cause));
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
      reportSetupError("Couldn't close capture setup", Cause.squash(closed.cause));
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
      <SettingsSection id="snap-shot" title="SnapShots">
        <SettingsUnavailableGroup message={unavailableMessage}>
          <SettingsRow
            {...searchableSetting("snap-shot-enabled")}
            description={snapShotDescription(state)}
            status={
              bridge
                ? setupBusy && !wizard
                  ? "Updating capture settings…"
                  : refreshError
                    ? `${refreshError.title}. ${refreshError.message}`
                    : snapShotStatus(state, settings.snapShotEnabled)
                : undefined
            }
            control={
              <>
                {settings.snapShotEnabled &&
                !snapShotSetupComplete(state, settings.snapShotIncludeAccessibility) ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={setupBusy}
                    onClick={() => void openSetup()}
                  >
                    {snapShotSetupButtonLabel(state)}
                  </Button>
                ) : null}
                <Switch
                  checked={settings.snapShotEnabled || Boolean(wizard)}
                  disabled={!captureAvailable || setupBusy}
                  aria-label="Enable snapshots"
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
                {...searchableSetting("snap-shot-accessibility")}
                description="Include text and controls when the app makes them available."
                status={snapShotAccessibilityUnavailableMessage(state)}
                control={
                  <Switch
                    checked={
                      !snapShotAccessibilityUnavailableMessage(state) &&
                      settings.snapShotIncludeAccessibility
                    }
                    disabled={
                      !captureAvailable || Boolean(snapShotAccessibilityUnavailableMessage(state))
                    }
                    aria-label="Include app text in snapshots"
                    onCheckedChange={(checked) => void saveIncludeAccessibility(checked)}
                  />
                }
              />
              <SettingsRow
                {...searchableSetting("snap-shot-shortcut")}
                description={
                  state?.linuxBackend === "picker"
                    ? "Choose a window to capture from any app."
                    : "Capture the window you're using without switching apps."
                }
                status={managedShortcut ? undefined : shortcutStatus}
                control={
                  managedShortcut ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={setupBusy}
                      onClick={() => void openSetup("shortcut")}
                    >
                      Change shortcut
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
                            {setupBusy ? "Saving…" : "Save"}
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
                            Cancel
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
                          Shortcut permissions
                        </Button>
                      ) : null}
                    </>
                  )
                }
              />
              <SettingsRow
                {...searchableSetting("snap-shot-sound")}
                description="Choose the sound played when capture starts."
                control={
                  <Menu>
                    <MenuTrigger
                      aria-label={"Snapshot sound: " + soundLabel}
                      render={<SelectButton size="sm" />}
                      className="w-auto min-w-0"
                      disabled={!captureAvailable}
                    >
                      {soundSelection === "off" ? (
                        "Off"
                      ) : soundSelection === "soft-pop" ? (
                        <>
                          Whoosh <span className="text-muted-foreground">(Default)</span>
                        </>
                      ) : (
                        "Click"
                      )}
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuRadioGroup
                        onValueChange={(value) =>
                          void save(snapShotSoundPatch(value as SnapShotSoundSelection))
                        }
                        value={soundSelection}
                      >
                        <MenuRadioItem closeOnClick value="off">
                          Off
                        </MenuRadioItem>
                        <div className={soundOptionRowClassName}>
                          <MenuRadioItem closeOnClick value="soft-pop">
                            Whoosh <span className="text-muted-foreground">(Default)</span>
                          </MenuRadioItem>
                          <MenuItem
                            aria-label="Play Whoosh"
                            closeOnClick={false}
                            onClick={() => playSnapShotSound("soft-pop")}
                          >
                            <PlayIcon />
                          </MenuItem>
                        </div>
                        <div className={soundOptionRowClassName}>
                          <MenuRadioItem closeOnClick value="camera-shutter">
                            Click
                          </MenuRadioItem>
                          <MenuItem
                            aria-label="Play Click"
                            closeOnClick={false}
                            onClick={() => playSnapShotSound("camera-shutter")}
                          >
                            <PlayIcon />
                          </MenuItem>
                        </div>
                      </MenuRadioGroup>
                    </MenuPopup>
                  </Menu>
                }
              />
              <SettingsRow
                {...searchableSetting("snap-shot-flash")}
                description="Show a gentle cue on the captured window."
                status={feedbackUnavailable}
                control={
                  <Switch
                    checked={!feedbackUnavailable && settings.snapShotFlash}
                    disabled={!captureAvailable || Boolean(feedbackUnavailable)}
                    aria-label="Flash captured window"
                    onCheckedChange={(checked) => void save({ snapShotFlash: checked })}
                  />
                }
              />
              <SettingsRow
                {...searchableSetting("snap-shot-animations")}
                description="Animate captured windows into your draft."
                status={feedbackUnavailable}
                control={
                  <Switch
                    checked={!feedbackUnavailable && settings.snapShotAnimations}
                    disabled={!captureAvailable || Boolean(feedbackUnavailable)}
                    aria-label="Animate snapshots"
                    onCheckedChange={(checked) => void save({ snapShotAnimations: checked })}
                  />
                }
              />
            </>
          ) : null}
        </SettingsUnavailableGroup>
      </SettingsSection>
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
