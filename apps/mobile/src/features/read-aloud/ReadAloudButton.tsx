import { useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_READ_ALOUD_SETTINGS } from "@t3tools/contracts";
import { Pressable } from "react-native";
import { mobilePreferencesAtom } from "../../state/preferences";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { readAloudController } from "./playback";

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
  if (settings.provider === "off") return null;
  const active = state.id === id;
  const stoppable = active && (state.status === "playing" || state.status === "loading");
  const label = stoppable
    ? "Stop reading"
    : active && state.status === "paused"
      ? "Resume reading"
      : "Read aloud";
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
        const result = readAloudController.getSnapshot();
        if (result.id === id && result.status === "error")
          Dialog.alert("Could not read aloud", result.error);
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
