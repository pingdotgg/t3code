import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthSettingsWriteScope,
  type ScopedThreadRef,
  type ProjectSettingsOverrides,
  SpeechPlaybackRate,
  SpeechOutputDestination,
} from "@t3tools/contracts";
import type { SpeechPlaybackControls } from "@t3tools/client-runtime/voice-output";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { createContext, useContext, useRef } from "react";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { useQuietThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { voiceOutput } from "./voiceOutput";

export const SpeechPlaybackSettingsContext = createContext<SpeechPlaybackControls | null>(null);

export function useSpeechOutputDestination(
  threadRef: ScopedThreadRef | null = null,
): SpeechPlaybackControls {
  const scoped = useContext(SpeechPlaybackSettingsContext);
  const thread = useQuietThreadShell(threadRef);
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  const localDestination = useClientSettings((settings) => settings.speechOutputDestination);
  const localRate = useClientSettings((settings) => settings.speechPlaybackRate);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const canManage = useEnvironmentScope(threadRef?.environmentId ?? null, AuthSettingsWriteScope);
  const settings = environment?.serverConfig?.settings;
  const effective = settings
    ? resolveProjectSettings(settings, thread?.projectId ?? null).settings
    : null;
  const destination =
    effective?.speechPlaybackDestination === undefined
      ? localDestination
      : effective.speechPlaybackDestination;
  const playbackRate = effective?.speechPlaybackRate ?? localRate;
  const pending = useRef<{
    key: string;
    source: ProjectSettingsOverrides | undefined;
    value: ProjectSettingsOverrides;
  } | null>(null);
  const persist = (patch: {
    speechPlaybackDestination?: SpeechOutputDestination | null;
    speechPlaybackRate?: SpeechPlaybackRate;
  }) => {
    if (!threadRef || !thread?.projectId || !settings) return false;
    const key = `${threadRef.environmentId}:${thread.projectId}`;
    const source = settings.projectSettingsOverrides[thread.projectId];
    const previous = pending.current;
    const base = previous?.key === key && previous.source === source ? previous : null;
    const staged = { key, source, value: { ...(base?.value ?? source), ...patch } };
    pending.current = staged;
    void update({
      environmentId: threadRef.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [thread.projectId]: staged.value,
          },
        },
      },
    }).then((result) => {
      if (result._tag === "Failure" && pending.current === staged) pending.current = base;
    });
    return true;
  };
  const setPlaybackRate = (rate: SpeechPlaybackRate) => {
    if (threadRef && voiceOutput.getSnapshot().owner?.startsWith(`${scopedThreadKey(threadRef)}:`))
      voiceOutput.setPlaybackRate(rate);
    if (!persist({ speechPlaybackRate: rate }))
      void updateClientSettings({ speechPlaybackRate: rate });
  };
  const choose = (destination: SpeechOutputDestination | null) => {
    if (!persist({ speechPlaybackDestination: destination }))
      void updateClientSettings({ speechOutputDestination: destination });
  };
  return (
    scoped ?? {
      destination,
      choose,
      playbackRate,
      setPlaybackRate,
      selectVoice: (voice) => {
        if (destination) choose({ ...destination, voice });
      },
      canManage: threadRef ? canManage : true,
    }
  );
}
