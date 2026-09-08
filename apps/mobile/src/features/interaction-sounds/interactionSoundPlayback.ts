import type { AudioPlayer } from "expo-audio";

type InteractionSoundPlayer = Pick<AudioPlayer, "currentTime" | "play" | "seekTo">;

export async function replayInteractionSound(player: InteractionSoundPlayer): Promise<void> {
  if (player.currentTime > 0) {
    await player.seekTo(0);
  }
  player.play();
}
