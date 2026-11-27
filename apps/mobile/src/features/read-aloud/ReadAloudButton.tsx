import { useEffect, useSyncExternalStore } from "react";
import { useGT } from "gt-react-native";
import { Pressable } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { readAloudButtonAction, type ReadAloudHighlight } from "@t3tools/client-runtime/read-aloud";
import { readAloudController, warmReadAloud } from "./playback";
import { useReadAloudSettings } from "./useReadAloudSettings";

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
  const settings = useReadAloudSettings();
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loading the environment's local model while replies are on screen hides its startup from the first click.
  useEffect(() => warmReadAloud(settings), [settings]);
  const gt = useGT();
  if (settings.provider === "off") return null;
  const action = readAloudButtonAction(state, id);
  const reading = action !== "read";
  const label =
    action === "cancel"
      ? gt("Cancel speech generation")
      : action === "stop"
        ? gt("Stop reading")
        : action === "resume"
          ? gt("Resume reading")
          : gt("Read aloud");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: reading }}
      className="items-center justify-center"
      style={{ width: buttonSize, height: buttonSize }}
      onPress={async () => {
        await readAloudController.toggle(id, text, settings);
        alertReadAloudError(id, gt("Could not read aloud"));
      }}
    >
      {/* The same speaker as web; the player above the composer shows what is being read. */}
      <SymbolView
        name="speaker.wave.2"
        size={iconSize}
        tintColorClassName={reading ? "accent-foreground" : "accent-foreground-secondary"}
      />
    </Pressable>
  );
}
