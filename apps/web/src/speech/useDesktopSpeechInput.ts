import type { DesktopSpeechStatus } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../localApi";

export function useDesktopSpeechInput(onTranscript: (text: string) => void) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.speech;
  const [status, setStatus] = useState<DesktopSpeechStatus | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [level, setLevel] = useState(0);
  const activeRef = useRef(false);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    void bridge.getStatus().then((next) => {
      if (!disposed) setStatus(next);
    });
    const unsubscribe = bridge.onEvent((event) => {
      if (event.type === "status") {
        setStatus(event.status);
        activeRef.current = event.status.supported && event.status.state === "recording";
      } else if (event.type === "download-progress") {
        setProgress({ downloaded: event.downloaded, total: event.total });
      } else if (event.type === "level") {
        setLevel(event.level);
      } else if (event.type === "transcript") {
        transcriptRef.current(event.text);
      } else if (event.type === "error") {
        setStatus({ supported: true, state: "error", message: event.message });
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (activeRef.current) void bridge.cancel();
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !status?.supported || status.state !== "recording") return;
    const timeout = window.setTimeout(() => void bridge.stop(), 120_000);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      void bridge.cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [bridge, status]);

  const start = useCallback(async () => {
    if (!bridge) return;
    if (status?.supported && status.state === "missing-model") {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        "Download a 48 MiB English speech model? Voice input is processed locally and microphone audio is not saved.",
      );
      if (!confirmed) return;
    }
    setProgress(null);
    const next = await bridge.start();
    activeRef.current = next.supported && next.state === "recording";
    setStatus(next);
  }, [bridge, status]);

  const stop = useCallback(async () => {
    if (!bridge) return;
    activeRef.current = false;
    setStatus(await bridge.stop());
  }, [bridge]);

  const cancel = useCallback(async () => {
    if (!bridge) return;
    activeRef.current = false;
    setStatus(await bridge.cancel());
  }, [bridge]);

  return {
    available: bridge !== undefined && status?.supported !== false,
    status,
    progress,
    level,
    start,
    stop,
    cancel,
  };
}
