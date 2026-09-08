import { useAtomValue } from "@effect/atom-react";
import {
  isModifierPairShortcut,
  type ClientSettingsPatch,
  type DesktopSnapShotShortcutAvailability,
  type DesktopSnapShotState,
  type DesktopSnapShotSetupAction,
  type SnapShotShortcut,
} from "@t3tools/contracts";
import { ChevronDownIcon, PlayIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import {
  readSnapShotSetupResume,
  saveSnapShotSetupResume,
  clearSnapShotSetupResume,
} from "../../lib/snapShotSetupResume";
import { sameSnapShotShortcut, snapShotKeybindingConflict } from "../../lib/snapShotShortcut";
import { playSnapShotSound } from "../../lib/snapShotSound";
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
import { selectTriggerVariants } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SnapShotSetupDialog } from "./SnapShotSetupDialog";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";
import {
  captureSetupAccessReady,
  captureSetupInitialStep,
  captureSetupShouldDisableOnClose,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";

const soundOptionRowClassName =
  "grid grid-cols-[1fr_auto] rounded-sm has-data-checked:bg-foreground/[0.08]";
const soundOptionItemClassName = "data-checked:bg-transparent";
const soundPreviewClassName = "min-h-7 w-7 justify-center px-0";

function captureSettingsError(title: string, error: unknown) {
  return { title, message: error instanceof Error ? error.message : "Try again." };
}

type ShortcutCheck =
  | { readonly status: "idle"; readonly availability: null }
  | { readonly status: "checking"; readonly availability: null }
  | {
      readonly status: "checked";
      readonly availability: DesktopSnapShotShortcutAvailability;
    };

export function SnapShotSettings() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const bridge = getDesktopSnapShotBridge();
  const [state, setState] = useState<DesktopSnapShotState | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<ReturnType<typeof captureSettingsError> | null>(
    null,
  );
  const [wizard, setWizard] = useState<{
    initialStep: CaptureSetupStep;
    wasEnabled: boolean;
  } | null>(null);
  const [candidate, setCandidate] = useState<SnapShotShortcut>(settings.snapShotShortcut);
  const [shortcutCheck, setShortcutCheck] = useState<ShortcutCheck>({
    status: "idle",
    availability: null,
  });
  const shortcutCheckIdRef = useRef(0);
  const stateRequestIdRef = useRef(0);
  const unavailableMessage = snapShotUnavailableMessage(Boolean(bridge));
  const captureAvailable = Boolean(bridge) && state !== null && state.mode !== "unavailable";
  const feedbackUnavailable = snapShotFeedbackUnavailableMessage(state);
  const savedShortcut = settings.snapShotShortcut;
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

  const refreshState = useCallback(async () => {
    const requestId = ++stateRequestIdRef.current;
    try {
      if (bridge) {
        const nextState = await bridge.getSnapShotState();
        if (requestId === stateRequestIdRef.current) setState(nextState);
        return nextState;
      }
    } catch (error) {
      if (requestId === stateRequestIdRef.current)
        setSetupError(captureSettingsError("Couldn't check capture setup", error));
    }
  }, [bridge]);

  const setup = useCallback(
    async (action: DesktopSnapShotSetupAction) => {
      if (!bridge?.setupSnapShot || setupBusy) return;
      setSetupBusy(true);
      setSetupError(null);
      try {
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
      } catch (error) {
        setSetupError(
          captureSettingsError(
            action === "retry-shortcut"
              ? "Couldn't open shortcut permissions"
              : "Couldn't complete capture setup",
            error,
          ),
        );
      } finally {
        setSetupBusy(false);
      }
    },
    [bridge, refreshState, setupBusy, state, wizard],
  );

  useEffect(() => {
    if (!setupError || wizard) return;
    toastManager.add({
      type: "error",
      title: setupError.title,
      description: setupError.message,
    });
    setSetupError(null);
  }, [setupError, wizard]);

  useEffect(() => {
    let cancelled = false;
    void refreshState().then((current) => {
      const resume = readSnapShotSetupResume();
      if (!cancelled && current?.macPermissions && resume) {
        setWizard({ initialStep: "access", wasEnabled: resume.wasEnabled });
      }
    });
    window.addEventListener("focus", refreshState);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshState);
    };
  }, [refreshState]);

  useEffect(
    () =>
      bridge?.onSnapShotEvent((event) => {
        if (event.type === "shortcut-changed") void refreshState();
      }),
    [bridge, refreshState],
  );

  useEffect(() => {
    shortcutCheckIdRef.current++;
    setCandidate(savedShortcut);
    setShortcutCheck({ status: "idle", availability: null });
  }, [savedShortcut]);

  const save = useCallback(
    async (patch: ClientSettingsPatch) => {
      setSetupError(null);
      try {
        await updateSettings(patch);
        return await refreshState();
      } catch (error) {
        setSetupError(captureSettingsError("Couldn't save capture settings", error));
      }
    },
    [refreshState, updateSettings],
  );

  const saveIncludeAccessibility = useCallback(
    async (includeAccessibility: boolean) => {
      try {
        if (includeAccessibility && settings.snapShotEnabled)
          await bridge?.requestSnapShotPermissions(true);
        await save({ snapShotIncludeAccessibility: includeAccessibility });
      } catch (error) {
        setSetupError(captureSettingsError("Couldn't allow app text capture", error));
      }
    },
    [bridge, save, settings.snapShotEnabled],
  );

  const checkShortcut = useCallback(
    async (shortcut: SnapShotShortcut) => {
      const checkId = ++shortcutCheckIdRef.current;
      setCandidate(shortcut);
      const conflict = snapShotKeybindingConflict(shortcut, keybindings);
      if (conflict || !bridge) return;
      setShortcutCheck({ status: "checking", availability: null });
      try {
        const availability = await bridge.checkSnapShotShortcut(shortcut);
        if (checkId === shortcutCheckIdRef.current) {
          setShortcutCheck({ status: "checked", availability });
        }
      } catch (error) {
        if (checkId !== shortcutCheckIdRef.current) return;
        setShortcutCheck({
          status: "checked",
          availability: {
            available: false,
            message: error instanceof Error ? error.message : "Could not check this shortcut.",
          },
        });
      }
    },
    [bridge, keybindings],
  );

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
      setShortcutCheck({ status: "checked", availability: { available: false, message } }),
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
    try {
      let current = await refreshState();
      if (!current) return;
      if (current.macPermissions) requested = "access";
      if (!settings.snapShotEnabled && captureSetupInitialStep(current, requested) !== "access") {
        // Opening setup is the opt-in. Restore registration before resuming a
        // later step, just as Continue does on the access step.
        current = await save({ snapShotEnabled: true });
        if (!current) {
          // A settings write can succeed even if the following status check
          // fails. Keep Finish later available to turn capture back off.
          setWizard({ initialStep: "access", wasEnabled: false });
          return;
        }
      }
      setWizard({
        initialStep: captureSetupInitialStep(current, requested),
        wasEnabled: settings.snapShotEnabled,
      });
    } finally {
      setSetupBusy(false);
    }
  };

  const enableForSetup = async () => {
    if (setupBusy) return false;
    setSetupBusy(true);
    setSetupError(null);
    try {
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
    } catch (error) {
      setSetupError(captureSettingsError("Couldn't verify capture access", error));
      return false;
    } finally {
      setSetupBusy(false);
    }
  };

  const refreshSetup = useCallback(() => {
    setSetupError(null);
    return refreshState();
  }, [refreshState]);

  const closeSetup = async (completed: boolean) => {
    if (!wizard || setupBusy) return;
    setSetupBusy(true);
    try {
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
    } catch (error) {
      setSetupError(captureSettingsError("Couldn't close capture setup", error));
    } finally {
      setSetupBusy(false);
    }
  };

  const saveShortcut = async () => {
    if (!canSaveShortcut || setupBusy) return false;
    setSetupBusy(true);
    try {
      const saved = await save({ snapShotShortcut: candidate });
      return Boolean(saved?.shortcutRegistered || saved?.shortcutPending);
    } finally {
      setSetupBusy(false);
    }
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
                      className={cn(selectTriggerVariants({ size: "sm" }), "w-auto min-w-0")}
                      disabled={!captureAvailable}
                    >
                      <span className="min-w-0 flex-1 truncate text-left">
                        {soundSelection === "off" ? (
                          "Off"
                        ) : soundSelection === "soft-pop" ? (
                          <>
                            Whoosh <span className="text-muted-foreground">(Default)</span>
                          </>
                        ) : (
                          "Click"
                        )}
                      </span>
                      <ChevronDownIcon className="-me-1 size-3 shrink-0 opacity-50" />
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
                          <MenuRadioItem
                            className={soundOptionItemClassName}
                            closeOnClick
                            value="soft-pop"
                          >
                            Whoosh <span className="text-muted-foreground">(Default)</span>
                          </MenuRadioItem>
                          <MenuItem
                            aria-label="Play Whoosh"
                            className={soundPreviewClassName}
                            closeOnClick={false}
                            onClick={() => playSnapShotSound("soft-pop")}
                          >
                            <PlayIcon />
                          </MenuItem>
                        </div>
                        <div className={soundOptionRowClassName}>
                          <MenuRadioItem
                            className={soundOptionItemClassName}
                            closeOnClick
                            value="camera-shutter"
                          >
                            Click
                          </MenuRadioItem>
                          <MenuItem
                            aria-label="Play Click"
                            className={soundPreviewClassName}
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
          error={setupError?.message ?? null}
          shortcutInput={shortcutInput}
          shortcutStatus={shortcutStatus}
          shortcutChanged={shortcutChanged}
          canSaveShortcut={canSaveShortcut}
          onSaveShortcut={saveShortcut}
          onEnable={enableForSetup}
          onAction={setup}
          onRefresh={refreshSetup}
          onClose={closeSetup}
          onLeaveStep={stopRecording}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
