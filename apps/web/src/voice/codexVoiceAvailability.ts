import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { voiceAvailability } from "@t3tools/client-runtime/voice-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { runtime } from "../lib/runtime";
import { usePreparedConnection } from "../state/session";

export function useCodexVoiceAvailability(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  enabled: boolean,
) {
  const connection = usePreparedConnection(environmentId);
  const prepared = connection._tag === "Some" ? connection.value : null;
  const lastWarm = useRef(0);
  const warmRef = useRef(() => {});
  const key = `${environmentId}:${instanceId}`;
  const [result, setResult] = useState<{ key: string; available: boolean } | null>(null);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A new connection or probe lifetime invalidates the previous server response.
    setResult(null);
    if (!enabled) return;
    if (!prepared) return;
    lastWarm.current = 0;
    const aborter = new AbortController();
    let generation = 0;
    const warm = () => {
      if (document.visibilityState === "hidden" || Date.now() - lastWarm.current < 15_000) return;
      lastWarm.current = Date.now();
      const requestGeneration = ++generation;
      setResult(null);
      void runtime
        .runPromise(voiceAvailability(prepared, instanceId), { signal: aborter.signal })
        .then(
          (response) => {
            if (!aborter.signal.aborted && requestGeneration === generation)
              setResult({ key, available: response.codexVoiceAvailable });
          },
          () => {
            if (!aborter.signal.aborted && requestGeneration === generation)
              setResult({ key, available: false });
          },
        );
    };
    warmRef.current = warm;
    warm();
    // Returning after the server's idle warm slot expires should start preparing
    // before the user clicks the mic, without keeping a CLI alive in the background.
    window.addEventListener("focus", warm);
    document.addEventListener("visibilitychange", warm);
    return () => {
      aborter.abort();
      warmRef.current = () => {};
      window.removeEventListener("focus", warm);
      document.removeEventListener("visibilitychange", warm);
    };
  }, [key, prepared, instanceId, enabled]);
  const prepare = useCallback(() => {
    warmRef.current();
  }, []);
  return { available: !enabled ? false : result?.key === key ? result.available : null, prepare };
}
