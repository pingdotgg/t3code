import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { Progress } from "../../components/ui/Progress";
import { formatBytes } from "../../lib/formatBytes";
import {
  parakeetUltraActions,
  parakeetUltraSize,
  parakeetUltraStateAtom,
} from "../../native/parakeetUltra";
import type { DeviceVoiceEngine } from "../../persistence/mobile-preferences";
import { saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  iosVoiceEngineAtom,
  localVoiceTranscriberAtom,
  useGlobalVoiceInput,
} from "../voice-input/VoiceInputProvider";
import { SettingsSection } from "./components/SettingsSection";

export function DeviceVoiceEngineSection() {
  const gt = useGT();
  const engine = useAtomValue(iosVoiceEngineAtom);
  const apple = useAtomValue(localVoiceTranscriberAtom);
  const modelState = useAtomValue(parakeetUltraStateAtom);
  const { isBusy } = useGlobalVoiceInput();
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const appleSpeech = "Apple Speech";
  const model = "Parakeet Ultra";
  const actions = parakeetUltraActions;

  const select = async (choice: DeviceVoiceEngine) => {
    if (choice === engine) return;
    const result = await savePreferences({ deviceVoiceEngine: choice });
    if (result._tag === "Failure") Dialog.alert(gt("Could not save transcription choice"));
  };

  let description: string;
  let action: ReactNode = null;
  switch (modelState.kind) {
    case "checking":
      description = gt("Checking model…");
      break;
    case "unavailable":
      description = gt("Transcription unavailable");
      break;
    case "missing":
    case "failed":
      description =
        modelState.kind === "failed"
          ? gt("Download failed. Try again.")
          : parakeetUltraSize === null
            ? gt("Transcription unavailable")
            : gt("Download {size} for offline dictation.", {
                size: formatBytes(parakeetUltraSize),
              });
      action = actions && (
        <ListActionRow
          icon="arrow.down.circle"
          label={gt("Download {model}", { model })}
          onPress={() =>
            void actions.download().catch(() => Dialog.alert(gt("Could not download the model")))
          }
        />
      );
      break;
    case "downloading":
    case "verifying":
      description =
        modelState.kind === "downloading"
          ? gt("Downloading {model}…", { model })
          : gt("Verifying download…");
      action = actions && (
        <ListActionRow
          label={gt("Cancel download")}
          onPress={() =>
            void actions.cancel().catch(() => Dialog.alert(gt("Could not cancel the download")))
          }
        />
      );
      break;
    case "cancelling":
      description = gt("Cancelling download…");
      break;
    case "ready":
      description = gt("Detects the spoken language and transcribes after you stop.");
      action = actions && (
        <ListActionRow
          icon="trash"
          label={gt("Remove {model}", { model })}
          tone="danger"
          disabled={isBusy}
          onPress={() =>
            Dialog.confirm({
              title: gt("Remove {model}?", { model }),
              message: gt("Download the model again to use it for dictation."),
              confirmText: gt("Remove", { $context: "verb" }),
              destructive: true,
              onConfirm: () =>
                void actions.remove().catch(() => Dialog.alert(gt("Could not remove the model"))),
            })
          }
        />
      );
      break;
  }

  return (
    <SettingsSection title={gt("Method on this device")}>
      <ListChoiceRow
        label={appleSpeech}
        description={
          apple === null
            ? gt("Requires iOS 26 or later and a supported device and language.")
            : undefined
        }
        selected={engine === "apple-speech"}
        disabled={engine === "checking"}
        onPress={() => void select("apple-speech")}
      />
      <ListChoiceRow
        label={model}
        description={description}
        selected={engine === "parakeet-ultra"}
        disabled={engine === "checking" || modelState.kind !== "ready"}
        separated
        onPress={() => void select("parakeet-ultra")}
      />
      {modelState.kind === "downloading" ? (
        <View className="bg-grouped-card px-4 pb-3">
          <Progress label={description} value={modelState.percent / 100} />
        </View>
      ) : null}
      {action ? <View className="border-t border-border-subtle">{action}</View> : null}
    </SettingsSection>
  );
}
