import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { speechModelDownloadPercent } from "@t3tools/shared/speech";
import { useGT } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { formatBytes } from "../../lib/formatBytes";
import {
  deviceSpeechCatalog,
  deviceSpeechModelActions,
  deviceSpeechModelStatesAtom,
} from "../../native/deviceSpeechModels";
import { saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  iosVoiceModelAtom,
  localVoiceTranscriberAtom,
  useGlobalVoiceInput,
} from "../voice-input/VoiceInputProvider";
import { SettingsSection } from "./components/SettingsSection";
import { isDownloading, type VoiceModel, type VoiceModelList } from "./VoiceModelSection";

export function useDeviceVoiceModels() {
  const gt = useGT();
  const activeId = useAtomValue(iosVoiceModelAtom);
  const catalog = useAtomValue(deviceSpeechModelStatesAtom);
  const { isBusy } = useGlobalVoiceInput();
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const actions = deviceSpeechModelActions;

  const models = deviceSpeechCatalog
    .map((model): VoiceModel => {
      const state = catalog.kind === "ready" ? catalog.states[model.id] : undefined;
      return {
        ...model,
        active: activeId === model.id,
        state:
          state?.kind === "ready"
            ? "installed"
            : state?.kind === "missing" || !state
              ? "downloadable"
              : state.kind,
        ...(state?.kind === "downloading"
          ? { downloaded: Math.ceil((model.size * state.percent) / 100) }
          : {}),
      };
    })
    .filter((model) => model.canRun !== false || model.state === "installed");

  const select = async (id: string | null) => {
    if (id === activeId) return;
    const result = await savePreferences({ deviceVoiceModelId: id });
    if (result._tag === "Failure") Dialog.alert(gt("Could not save transcription choice"));
  };

  const voice: VoiceModelList = {
    models,
    loading: catalog.kind === "checking",
    canManage: catalog.kind === "ready" && activeId !== undefined && actions !== null,
    busy: isBusy,
    downloading: models.some(isDownloading),
    download: (model) => {
      if (!actions) return;
      Dialog.confirm({
        title: gt("Download {model}?", { model: model.name }),
        message: gt("Download {size} for offline dictation.", { size: formatBytes(model.size) }),
        confirmText: gt("Download", { $context: "verb" }),
        onConfirm: () =>
          void actions
            .download(model.id)
            .catch(() => Dialog.alert(gt("Could not download the model"))),
      });
    },
    select: (model) => void select(model.id),
    cancel: (model) =>
      void actions?.cancel(model.id).catch(() => Dialog.alert(gt("Could not cancel the download"))),
    remove: (model) =>
      void actions?.remove(model.id).catch(() => Dialog.alert(gt("Could not remove the model"))),
  };
  return { voice, activeId, select };
}

export function DeviceVoiceEngineSection() {
  const gt = useGT();
  const navigation = useNavigation();
  const apple = useAtomValue(localVoiceTranscriberAtom);
  const { voice, activeId, select } = useDeviceVoiceModels();
  const appleSpeech = "Apple Speech";
  const active = voice.models.find((model) => model.active);
  const pending = voice.models.find(isDownloading);

  let detail = gt("Transcription models");
  if (pending?.state === "downloading") {
    detail = gt("Downloading {model} · {percent}%", {
      model: pending.name,
      percent: speechModelDownloadPercent(pending.downloaded ?? 0, pending.size),
    });
  } else if (pending?.state === "verifying") {
    detail = gt("Verifying {model}…", { model: pending.name });
  } else if (pending?.state === "cancelling") {
    detail = gt("Cancelling download…");
  } else if (active?.state === "installed") {
    detail =
      active.canRun === false
        ? gt("Transcription unavailable")
        : gt("Local model · {size}", { size: formatBytes(active.size) });
  } else if (!voice.models.some((model) => model.state === "installed")) {
    detail = gt("No model installed · Choose one to download");
  }

  return (
    <SettingsSection title={gt("Method on this device")}>
      <ListChoiceRow
        label={appleSpeech}
        description={
          apple === null
            ? gt(
                "Dictation on this device needs iOS 26 or later, a supported device, and a supported language. Your keyboard’s dictation is separate.",
              )
            : undefined
        }
        selected={activeId === null}
        disabled={activeId === undefined}
        onPress={() => void select(null)}
      />
      {voice.models.length > 0 ? (
        <ListRow
          label={active?.name ?? gt("Local model")}
          description={detail}
          selected={activeId !== undefined && activeId !== null}
          onPress={() => navigation.navigate("SettingsVoiceModels", { source: "device" })}
        />
      ) : null}
    </SettingsSection>
  );
}
