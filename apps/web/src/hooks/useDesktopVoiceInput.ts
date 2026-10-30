import { randomUUID } from "../lib/utils";
import { useEffect, useRef, useState } from "react";
import {
  resolveTranscriptCommit,
  type VoiceDraftSnapshot,
} from "@t3tools/client-runtime/voice-input/commit";
import { useStableCallback } from "./useStableCallback";

export type DesktopVoicePhase = "idle" | "preparing" | "recording" | "transcribing" | "error";

export function useDesktopVoiceInput(options: {
  readonly ownerKey: string;
  readonly readDraft: () => VoiceDraftSnapshot;
  readonly commitDraft: (text: string, cursor: number) => void;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.voiceInput;
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<DesktopVoicePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const active = useRef<string | null>(null);
  const readDraft = useStableCallback(options.readDraft);
  const commitDraft = useStableCallback(options.commitDraft);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes native capability without requesting microphone permission.
  useEffect(() => {
    let disposed = false;
    void bridge
      ?.available()
      .then((value) => {
        if (!disposed) setAvailable(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [bridge]);

  const cancel = useStableCallback(() => {
    const id = active.current;
    active.current = null;
    setPhase("idle");
    setError(null);
    if (id) void bridge?.cancel(id).catch(() => {});
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- native recordings belong to one mounted draft and must be cancelled on navigation.
  useEffect(() => {
    const ownerKey = options.ownerKey;
    const unsubscribe = bridge?.onRecording((id) => {
      if (readDraft().ownerKey !== ownerKey) return;
      if (active.current === id) setPhase("recording");
    });
    return () => {
      unsubscribe?.();
      cancel();
    };
  }, [bridge, options.ownerKey, cancel, readDraft]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape must release native microphone capture even when the editor has focus.
  useEffect(() => {
    if (phase === "idle" || phase === "error") return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [phase, cancel]);

  const start = useStableCallback(async () => {
    if (!bridge || !available || active.current) return;
    const captured = readDraft();
    const id = randomUUID();
    active.current = id;
    setError(null);
    setPhase("preparing");
    return bridge
      .start(id)
      .then((result) => {
        if (active.current !== id) return;
        const insertion = resolveTranscriptCommit(
          captured,
          readDraft(),
          result.text,
          result.locale,
        );
        if (insertion.kind !== "commit") {
          active.current = null;
          setError(
            insertion.kind === "stale"
              ? "The draft changed. The transcript was not added."
              : "No speech was detected. Try again.",
          );
          setPhase("error");
          return;
        }
        commitDraft(insertion.text, insertion.selection.end);
        active.current = null;
        setPhase("idle");
      })
      .catch((cause) => {
        if (active.current !== id) return;
        active.current = null;
        setError(cause instanceof Error ? cause.message : "Voice input failed. Try again.");
        setPhase("error");
      });
  });

  const stop = useStableCallback(async () => {
    const id = active.current;
    if (!bridge || !id || phase !== "recording") return;
    setPhase("transcribing");
    try {
      await bridge.stop(id);
    } catch (cause) {
      if (active.current !== id) return;
      cancel();
      setError(cause instanceof Error ? cause.message : "Could not finish voice input.");
      setPhase("error");
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finish bounded recording through the same UI path as the confirm button.
  useEffect(() => {
    if (phase !== "recording") return;
    const timeout = window.setTimeout(() => {
      void stop();
    }, 300_000);
    return () => window.clearTimeout(timeout);
  }, [phase, stop]);

  return {
    available,
    phase,
    error,
    start,
    stop,
    cancel,
    isActive: () => active.current !== null,
    busy: phase === "preparing" || phase === "recording" || phase === "transcribing",
  };
}
