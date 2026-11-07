import {
  isModifierPairShortcut,
  type SnapShotModifier,
  type SnapShotShortcut,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../../hooks/useI18n";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import {
  formatSnapShotShortcutLabel,
  parseDesktopSnapShotShortcut,
} from "../../lib/snapShotShortcut";
import { SnapShotShortcutKeys } from "../desktop/SnapShotShortcutKeys";
import { Button } from "../ui/button";
import { keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";
import { createRecordingRequestTracker } from "./SnapShotSettings.logic";

const MODIFIER_FROM_KEY: Readonly<Record<string, SnapShotModifier>> = {
  Shift: "shift",
  Meta: "meta",
  OS: "meta",
  Control: "control",
  Alt: "alt",
  AltGraph: "alt",
};
const MODIFIER_CODES: Readonly<Record<SnapShotModifier, readonly [string, string]>> = {
  shift: ["ShiftLeft", "ShiftRight"],
  meta: ["MetaLeft", "MetaRight"],
  control: ["ControlLeft", "ControlRight"],
  alt: ["AltLeft", "AltRight"],
};

export function useSnapShotShortcutRecorder({
  shortcut,
  shortcutLabel,
  disabled = false,
  allowModifierPairs = true,
  onRecord,
  onStart,
  onError,
}: {
  shortcut: SnapShotShortcut;
  shortcutLabel?: string | undefined;
  disabled?: boolean;
  allowModifierPairs?: boolean;
  onRecord: (shortcut: SnapShotShortcut) => void;
  onStart?: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const bridge = getDesktopSnapShotBridge();
  const displayShortcut = shortcutLabel ? parseDesktopSnapShotShortcut(shortcutLabel) : shortcut;
  const [recording, setRecording] = useState(false);
  const [requests] = useState(createRecordingRequestTracker);
  const heldModifierCodes = useRef(new Set<string>());
  const stopRecording = () => {
    requests.clear();
    heldModifierCodes.current.clear();
    setRecording(false);
    void bridge?.setSnapShotShortcutSuppressed(false).catch(() => undefined);
  };
  const startRecording = async () => {
    if (!bridge || disabled) return;
    const request = requests.tryBegin();
    if (!request) return;
    heldModifierCodes.current.clear();
    onStart?.();
    try {
      await bridge.setSnapShotShortcutSuppressed(true);
      if (requests.owns(request)) setRecording(true);
    } catch (error) {
      if (!requests.owns(request)) return;
      requests.clear();
      onError(
        error instanceof Error
          ? error.message
          : t("settings.providers.snapshot.recorder.startError"),
      );
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the desktop bridge's SnapShot shortcut suppression on unmount
  useEffect(
    () => () => {
      requests.clear();
      void bridge?.setSnapShotShortcutSuppressed(false).catch(() => undefined);
    },
    [bridge, requests],
  );
  const recordShortcut = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording || event.key === "Tab" || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      return;
    }
    const modifier = MODIFIER_FROM_KEY[event.key];
    if (modifier) {
      const held = heldModifierCodes.current;
      held.add(event.code);
      const [left, right] = MODIFIER_CODES[modifier];
      if (held.has(left) && held.has(right)) {
        if (!allowModifierPairs) {
          onError(t("settings.providers.snapshot.recorder.needsKey"));
          return;
        }
        stopRecording();
        onRecord(
          modifier === "shift" ? { kind: "both-shift-keys" } : { kind: "modifier-pair", modifier },
        );
      }
      return;
    }
    // A global shortcut without a modifier would take that key from every app.
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return;
    const input = keybindingFromKeyboardEvent(event, navigator.platform);
    if (!input) return;
    const next = parseKeybindingShortcut(input);
    if (!next) return;
    stopRecording();
    onRecord(next);
  };

  return {
    recording,
    stopRecording,
    input: (
      <Button
        type="button"
        size="xs"
        variant={recording ? "secondary" : "outline"}
        disabled={disabled}
        aria-label={
          displayShortcut
            ? t("settings.providers.snapshot.recorder.recordA11y", {
                shortcut: formatSnapShotShortcutLabel(displayShortcut),
              })
            : t("settings.providers.snapshot.recorder.changeA11y")
        }
        aria-pressed={recording}
        data-keybinding-capture=""
        onClick={() => void startRecording()}
        onKeyDown={recordShortcut}
        onKeyUp={(event) => heldModifierCodes.current.delete(event.code)}
        onBlur={stopRecording}
      >
        {recording ? (
          t("settings.providers.snapshot.recorder.press")
        ) : !displayShortcut ? (
          t("settings.providers.snapshot.changeShortcut")
        ) : !allowModifierPairs && isModifierPairShortcut(displayShortcut) ? (
          t("settings.providers.snapshot.recorder.choose")
        ) : (
          <SnapShotShortcutKeys shortcut={displayShortcut} />
        )}
      </Button>
    ),
  };
}
