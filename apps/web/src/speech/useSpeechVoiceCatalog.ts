import { useGT } from "gt-react";
import {
  getEnvironmentSpeechVoices,
  installEnvironmentSpeechRuntime,
  cancelEnvironmentSpeechRuntime,
  removeEnvironmentSpeechRuntime,
  downloadEnvironmentSpeechVoice,
  cancelEnvironmentSpeechVoiceDownload,
  selectEnvironmentSpeechVoice,
  removeEnvironmentSpeechVoice,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SpeechSynthesisVoices,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "../hooks/useStableCallback";
import { usePreparedConnection, useEnvironmentScope } from "../state/session";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";

export function useSpeechVoiceCatalog(environmentId: EnvironmentId | null) {
  const gt = useGT();
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const [result, setResult] = useState<{
    prepared: PreparedConnection | null;
    data: SpeechSynthesisVoices | null;
    error: string | null;
  }>({ prepared: null, data: null, error: null });
  const [pending, setPending] = useState<{
    prepared: PreparedConnection;
    voiceId: string;
    download: boolean;
  } | null>(null);
  const epoch = useRef(0);
  const revision = useRef(0);
  const data = result.prepared === prepared ? result.data : null;
  const error = result.prepared === prepared ? result.error : null;
  const action = pending?.prepared === prepared ? pending : null;
  const transfer =
    data?.voices.find((voice) => voice.state === "downloading" || voice.state === "verifying") ??
    (action?.download ? data?.voices.find((voice) => voice.id === action.voiceId) : null);
  const refresh = useStableCallback(async (connection: PreparedConnection) => {
    const current = epoch.current;
    const request = ++revision.current;
    try {
      const data = await runEnvironmentSpeech(getEnvironmentSpeechVoices(connection));
      if (current === epoch.current && request === revision.current)
        setResult({ prepared: connection, data, error: null });
    } catch {
      if (current === epoch.current && request === revision.current)
        setResult((previous) => ({
          prepared: connection,
          data: previous.prepared === connection ? previous.data : null,
          error: gt("Could not load voices. Check the connection and try again."),
        }));
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the voice catalog from the selected environment and rejects stale connection results
  useEffect(() => {
    epoch.current++;
    if (prepared) void refresh(prepared);
    return () => {
      epoch.current++;
      setPending(null);
    };
  }, [prepared, refresh]);
  const downloading = Boolean(
    transfer || action?.download || data?.runtime?.state === "installing",
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes installation progress only while a voice download is active
  useEffect(() => {
    if (!prepared || !downloading) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh(prepared);
      if (!cancelled) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [prepared, downloading, refresh]);
  const run = async (
    voiceId: string,
    operation:
      | "download"
      | "select"
      | "remove"
      | "cancel"
      | "installRuntime"
      | "cancelRuntime"
      | "removeRuntime",
  ) => {
    if (!prepared || !canManage) return;
    const current = epoch.current;
    if (operation !== "cancel" && operation !== "cancelRuntime")
      setPending({
        prepared,
        voiceId,
        download: operation === "download" || operation === "installRuntime",
      });
    let updated: SpeechSynthesisVoices | undefined;
    try {
      const data = await runEnvironmentSpeech(
        {
          installRuntime: installEnvironmentSpeechRuntime,
          cancelRuntime: cancelEnvironmentSpeechRuntime,
          removeRuntime: removeEnvironmentSpeechRuntime,
          download: downloadEnvironmentSpeechVoice,
          select: selectEnvironmentSpeechVoice,
          remove: removeEnvironmentSpeechVoice,
          cancel: cancelEnvironmentSpeechVoiceDownload,
        }[operation](prepared, voiceId),
      );
      if (current === epoch.current) {
        updated = data;
        revision.current++;
        setResult({ prepared, data, error: null });
      }
    } catch {
      if (current === epoch.current)
        setResult((previous) => ({
          ...previous,
          error: operation.endsWith("Runtime")
            ? gt("Could not update Piper. Check the connection and try again.")
            : gt("Could not update this voice. Check the connection and try again."),
        }));
    }
    if (current === epoch.current && operation !== "cancel" && operation !== "cancelRuntime")
      setPending(null);
    return updated;
  };
  return {
    runtime: data?.runtime ?? null,
    providers: data?.providers ?? [],
    voices: data?.voices ?? [],
    error,
    connected: prepared !== null,
    loading: prepared !== null && !data && !error,
    canManage,
    downloading,
    transfer,
    busy: Boolean(action && !action.download),
    run,
    refresh: () => prepared && refresh(prepared),
  };
}
