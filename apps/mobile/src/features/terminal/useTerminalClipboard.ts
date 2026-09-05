import { useFocusEffect } from "@react-navigation/native";
import { environmentRpcKey } from "@t3tools/client-runtime/state/runtime";
import {
  createTerminalClipboardSession,
  createTerminalClipboardWriter,
} from "@t3tools/client-runtime/terminal-clipboard";
import type { EnvironmentId, TerminalAttachInput } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { AppState, Platform } from "react-native";
import { terminalEnvironment } from "../../state/terminal";

const writeClipboard = createTerminalClipboardWriter((text) => Clipboard.setStringAsync(text));

/** Route focus, not keyboard visibility, owns touch-driven TUI copies on iOS and Android. */
export function useTerminalClipboard(
  environmentId: EnvironmentId | null,
  input: TerminalAttachInput | null,
) {
  const target = useMemo(
    () => (environmentId !== null && input !== null ? { environmentId, input } : null),
    [environmentId, input],
  );
  const targetKey = useMemo(() => (target === null ? null : environmentRpcKey(target)), [target]);
  const latestTarget = useRef(target);
  useLayoutEffect(() => {
    latestTarget.current = target;
  }, [target]);

  useFocusEffect(
    useCallback(() => {
      // The key, not the object, restarts the session: equal attach values
      // recreated by a render must not drop a copy that is mid-sequence.
      const target = targetKey === null ? null : latestTarget.current;
      if (target === null) return;
      let active = false;
      const session = createTerminalClipboardSession({
        isEligible: () => active,
        onCopy: (text, canWrite) => void writeClipboard(text, canWrite),
      });
      const setActive = (next: boolean) => {
        active = next;
        if (!next) session.invalidate();
      };
      const stop = terminalEnvironment.observeAttach(target, session.update);
      const activate = () => setActive(AppState.currentState === "active");
      activate();
      const change = AppState.addEventListener("change", activate);
      // Android can lose interaction focus without changing AppState (e.g. its notification drawer).
      const blur =
        Platform.OS === "android"
          ? AppState.addEventListener("blur", () => setActive(false))
          : undefined;
      const focus =
        Platform.OS === "android" ? AppState.addEventListener("focus", activate) : undefined;
      return () => {
        setActive(false);
        stop();
        change.remove();
        blur?.remove();
        focus?.remove();
      };
    }, [targetKey]),
  );
}
