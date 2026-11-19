import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthSettingsWriteScope,
  type ScopedThreadRef,
  SpeechPlaybackRate,
  SpeechOutputDestination,
} from "@t3tools/contracts";
import {
  createSpeechProjectSettingsWriter,
  type SpeechPlaybackControls,
} from "@t3tools/client-runtime/voice-output";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { createContext, useContext, useRef } from "react";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { useQuietThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "../components/ui/toast";
import { msg } from "gt-react";
import { m } from "../i18n/messages";
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
  const writer = useRef<ReturnType<typeof createSpeechProjectSettingsWriter> | null>(null);
  const persist = (patch: {
    speechPlaybackDestination?: SpeechOutputDestination | null;
    speechPlaybackRate?: SpeechPlaybackRate;
  }) => {
    const projectId = thread?.projectId;
    if (!threadRef || !projectId || !settings) return false;
    if (!writer.current) writer.current = createSpeechProjectSettingsWriter();
    void writer.current(
      { environmentId: threadRef.environmentId, projectId },
      patch,
      () => {
        const latest = appAtomRegistry.get(
          serverEnvironment.configValueAtom(threadRef.environmentId),
        );
        return latest?.settings ?? settings;
      },
      async (value) => {
        const result = await update({
          environmentId: threadRef.environmentId,
          input: { patch: { projectSettingsOverrides: { [projectId]: value } } },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
          toastManager.add({
            type: "error",
            title: m(msg("Setting not saved")),
            description: m(msg("The save failed. Try reconnecting and saving again.")),
          });
        return result._tag === "Success"
          ? (result.value.projectSettingsOverrides[projectId] ?? {})
          : false;
      },
    );
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
