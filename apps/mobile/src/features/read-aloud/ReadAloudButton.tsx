import { useEffect, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_READ_ALOUD_SETTINGS } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable } from "react-native";
import { mobilePreferencesAtom } from "../../state/preferences";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import type { ReadAloudHighlight, ReadAloudMessage } from "@t3tools/client-runtime/read-aloud";
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

/** Shows `title` and the error when reading message `id` failed, or any message when null. */
export function alertReadAloudError(id: string | null, title: string) {
  const result = readAloudController.getSnapshot();
  if ((id === null || result.id === id) && result.status === "error")
    Dialog.alert(title, result.error);
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
  const active = state.id === id;
  const stoppable = active && (state.status === "playing" || state.status === "loading");
  const label = stoppable
    ? gt("Stop reading")
    : active && state.status === "paused"
      ? gt("Resume reading")
      : gt("Read aloud");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      className="items-center justify-center"
      style={{ width: buttonSize, height: buttonSize }}
      onPress={async () => {
        if (stoppable) return readAloudController.stop();
        if (active && state.status === "paused") await readAloudController.resume();
        else await readAloudController.start(id, text, settings);
        alertReadAloudError(id, gt("Could not read aloud"));
      }}
    >
      <SymbolView
        name={stoppable ? "stop.fill" : "play"}
        size={iconSize}
        tintColorClassName="accent-foreground-secondary"
      />
    </Pressable>
  );
}

/** Reads this message and every one after it aloud. */
export function PlayFromHereButton({
  messages,
  buttonSize,
  iconSize,
}: {
  /** The message and those after it, as the thread shows them when pressed. */
  messages: () => ReadonlyArray<ReadAloudMessage>;
  buttonSize: number;
  iconSize: number;
}) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const settings = AsyncResult.isSuccess(preferences)
    ? (preferences.value.readAloud ?? DEFAULT_READ_ALOUD_SETTINGS)
    : DEFAULT_READ_ALOUD_SETTINGS;
  const gt = useGT();
  if (settings.provider === "off") return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Play from here")}
      className="items-center justify-center"
      style={{ width: buttonSize, height: buttonSize }}
      onPress={async () => {
        await readAloudController.playFrom(messages(), settings);
        alertReadAloudError(null, gt("Could not read aloud"));
      }}
    >
      <SymbolView
        name="forward.end"
        size={iconSize}
        tintColorClassName="accent-foreground-secondary"
      />
    </Pressable>
  );
}
