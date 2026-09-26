import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { BrowserVoiceInputController, browserVoiceSupport } from "./browserVoiceInput";

export function useBrowserVoiceInput(input: {
  ownerKey: string;
  text: string;
  disabled: boolean;
  sendImmediately: boolean;
  readSelection: () => { start: number; end: number };
  commit: (text: string, cursor: number) => void;
  submit: () => void;
}) {
  const [state, setState] = useState<VoiceInputState>({
    phase: "idle",
    error: null,
    errorAction: null,
  });
  const [support] = useState(browserVoiceSupport);
  const latest = useRef(input);
  const revision = useRef(0);
  useLayoutEffect(() => {
    if (latest.current.ownerKey !== input.ownerKey || latest.current.text !== input.text) {
      revision.current += 1;
    }
    latest.current = input;
  }, [input]);
  const pending = useRef<{ ownerKey: string; text: string; send: boolean } | null>(null);
  const [controller] = useState(() =>
    support.create
      ? new BrowserVoiceInputController({
          create: support.create,
          readDraft: () => ({
            ownerKey: latest.current.ownerKey,
            text: latest.current.text,
            revision: revision.current,
            selection: latest.current.readSelection(),
          }),
          commit: (text, cursor, send) => {
            pending.current = { ownerKey: latest.current.ownerKey, text, send };
            latest.current.commit(text, cursor);
          },
          onState: setState,
        })
      : null,
  );

  // Let the committed text render before using the normal send handler. A
  // blocked submission remains a draft; it is not retried in a later render.
  useEffect(() => {
    const request = pending.current;
    if (!request || state.phase !== "idle") return;
    pending.current = null;
    if (
      request.ownerKey === input.ownerKey &&
      request.text === input.text &&
      !input.disabled &&
      request.send
    ) {
      input.submit();
    }
  }, [input, state.phase]);

  useEffect(
    () => () => {
      pending.current = null;
      controller?.cancel();
    },
    [controller, input.ownerKey],
  );

  useEffect(() => {
    if (input.disabled) controller?.cancel();
  }, [controller, input.disabled]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) controller?.cancel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && controller?.busy) {
        event.preventDefault();
        controller.cancel();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKey);
    };
  }, [controller]);

  return {
    state,
    busy: voiceInputBlocksSubmission(state),
    unavailableReason: support.unavailableReason,
    available: controller !== null,
    start: () => {
      if (!latest.current.disabled)
        controller?.start(navigator.language || "en-US", latest.current.sendImmediately);
    },
    stop: () => controller?.stop(),
    cancel: () => controller?.cancel(),
  };
}
