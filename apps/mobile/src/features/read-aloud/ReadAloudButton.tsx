import { useEffect, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_READ_ALOUD_SETTINGS } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable } from "react-native";
import { mobilePreferencesAtom } from "../../state/preferences";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { readAloudButtonMode, type ReadAloudHighlight } from "@t3tools/client-runtime/read-aloud";
import { readAloudController, warmReadAloud } from "./playback";

/**
 * The block and word being read in message `id` (the button's id), as markdown ranges of the
 * text that message renders plus text cues, or null while another message or none is read.
 */
export function useReadAloudHighlight(id: string): ReadAloudHighlight | null {
  return useSyncExternalStore(readAloudController.subscribeHighlight, () => {
    const highlight = readAloudController.getHighlight();
    return highlight?.id === id ? highlight : null;
  });
}

/** Shows `title` and the error when reading message `id` failed. */
export function alertReadAloudError(id: string, title: string) {
  const result = readAloudController.getSnapshot();
  if (result.id === id && result.status === "error") Dialog.alert(title, result.error);
}

export function ReadAloudButton({
  id,
  text,
  buttonSize,
  iconSize,
}: {
  id: string;
  text: string;
  buttonSize: number;
  iconSize: number;
}) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const settings = AsyncResult.isSuccess(preferences)
    ? (preferences.value.readAloud ?? DEFAULT_READ_ALOUD_SETTINGS)
    : DEFAULT_READ_ALOUD_SETTINGS;
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loading the environment's local model while replies are on screen hides its startup from the first click.
  useEffect(() => warmReadAloud(settings), [settings]);
  const gt = useGT();
  if (settings.provider === "off") return null;
  const { action, stoppable } = readAloudButtonMode(state, id);
  const label = {
    read: gt("Read aloud"),
    cancel: gt("Cancel speech generation"),
    pause: gt("Pause reading"),
    resume: gt("Resume reading"),
  }[action];
  const icon: Record<typeof action, AppSymbolName> = {
    read: "play",
    cancel: "stop.fill",
    pause: "pause",
    resume: "play",
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        className="items-center justify-center"
        style={{ width: buttonSize, height: buttonSize }}
        onPress={async () => {
          if (action === "cancel") return readAloudController.stop();
          if (action === "pause") return readAloudController.pause();
          if (action === "resume") await readAloudController.resume();
          else await readAloudController.start(id, text, settings);
          alertReadAloudError(id, gt("Could not read aloud"));
        }}
      >
        <SymbolView
          name={icon[action]}
          size={iconSize}
          tintColorClassName="accent-foreground-secondary"
        />
      </Pressable>
      {stoppable && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Stop reading")}
          className="items-center justify-center"
          style={{ width: buttonSize, height: buttonSize }}
          onPress={() => readAloudController.stop()}
        >
          <SymbolView
            name="stop.fill"
            size={iconSize}
            tintColorClassName="accent-foreground-secondary"
          />
        </Pressable>
      )}
    </>
  );
}
