import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { APP_BAR_HEIGHT } from "../../lib/layoutMetrics";
import {
  ComposerDictationCancelAction,
  ComposerDictationPrimaryAction,
  ComposerDictationStatus,
} from "./ComposerDictationControl";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { resolveVoiceComposerPresentation } from "./voiceInputPresentation";

export function GlobalVoiceInputControl() {
  const voice = useGlobalVoiceInput();
  const insets = useSafeAreaInsets();
  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  if (!presentation.statusLabel || (voice.ownerKey && voice.focusedOwners.has(voice.ownerKey))) {
    return null;
  }
  const content = (
    <View pointerEvents="box-none" className="absolute inset-0">
      <View
        className="absolute inset-x-3 mx-auto max-w-lg flex-row items-center rounded-2xl border border-border-subtle bg-card px-2 py-1"
        style={{ top: insets.top + APP_BAR_HEIGHT + 8 }}
      >
        <ComposerDictationCancelAction presentation={presentation} onCancel={voice.cancel} />
        <ComposerDictationStatus
          audioLevels={voice.audioLevels}
          elapsedSeconds={voice.elapsedSeconds}
          phase={voice.state.phase}
          presentation={presentation}
          onDismissError={voice.cancel}
        />
        <ComposerDictationPrimaryAction
          state={voice.state}
          presentation={presentation}
          isAvailable={voice.isAvailable}
          onStart={() => void voice.session.retry()}
          onConfirm={voice.stop}
          onCancel={voice.cancel}
        />
      </View>
    </View>
  );
  return Platform.OS === "ios" ? <FullWindowOverlay>{content}</FullWindowOverlay> : content;
}
