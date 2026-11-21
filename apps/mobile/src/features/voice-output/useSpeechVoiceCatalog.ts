import { useGT } from "gt-react-native";
import {
  getEnvironmentSpeechVoices,
  installEnvironmentSpeechRuntime,
  cancelEnvironmentSpeechRuntime,
  removeEnvironmentSpeechRuntime,
  downloadEnvironmentSpeechVoice,
  selectEnvironmentSpeechVoice,
  removeEnvironmentSpeechVoice,
  cancelEnvironmentSpeechVoiceDownload,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SpeechSynthesisVoices,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { runSpeech } from "../voice-input/voiceDestination";

export function useSpeechVoiceCatalog(environmentId: EnvironmentId) {
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
  const refresh = useCallback(async () => {
    if (!prepared) return;
    const current = epoch.current;
    const request = ++revision.current;
    await runSpeech(getEnvironmentSpeechVoices(prepared)).then(
      (data) => {
        if (current === epoch.current && request === revision.current)
          setResult({ prepared, data, error: null });
      },
      () => {
        if (current === epoch.current && request === revision.current)
          setResult((previous) => ({
            prepared,
            data: previous.prepared === prepared ? previous.data : null,
            error: gt("Could not load voices. Check the connection and try again."),
          }));
      },
    );
  }, [prepared, gt]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the catalog when the selected environment connects and rejects old connection results
  useEffect(() => {
    epoch.current++;
    void refresh();
    return () => {
      epoch.current++;
      setPending(null);
    };
  }, [refresh]);
  const downloading = Boolean(
    transfer || action?.download || data?.runtime?.state === "installing",
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the environment only while a voice download is active
  useEffect(() => {
    if (!prepared || !downloading) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
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
    await runSpeech(
      {
        installRuntime: installEnvironmentSpeechRuntime,
        cancelRuntime: cancelEnvironmentSpeechRuntime,
        removeRuntime: removeEnvironmentSpeechRuntime,
        download: downloadEnvironmentSpeechVoice,
        select: selectEnvironmentSpeechVoice,
        remove: removeEnvironmentSpeechVoice,
        cancel: cancelEnvironmentSpeechVoiceDownload,
      }[operation](prepared, voiceId),
    ).then(
      (data) => {
        if (current === epoch.current) {
          updated = data;
          revision.current++;
          setResult({ prepared, data, error: null });
        }
      },
      () => {
        if (current === epoch.current)
          setResult((previous) => ({
            ...previous,
            error: operation.endsWith("Runtime")
              ? gt("Could not update Piper. Check the connection and try again.")
              : gt("Could not update this voice. Check the connection and try again."),
          }));
      },
    );
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
    refresh,
  };
}
