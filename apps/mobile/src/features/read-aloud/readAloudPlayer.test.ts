import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type StatusListener = (status: Record<string, unknown>) => void;

const audio = vi.hoisted(() => ({
  players: [] as Array<{
    url: string;
    listener: StatusListener | null;
    released: boolean;
    emit: (status: Record<string, unknown>) => void;
  }>,
  sessionGranted: true,
  onRequested: null as ((requested: boolean) => void) | null,
}));

vi.mock("expo-audio", () => ({
  createAudioPlayer: (url: string) => {
    const player = {
      url,
      listener: null as StatusListener | null,
      released: false,
      emit(status: Record<string, unknown>) {
        player.listener?.(status);
      },
      addListener(_event: string, listener: StatusListener) {
        player.listener = listener;
        return { remove: () => (player.listener = null) };
      },
    };
    audio.players.push(player);
    return player;
  },
}));

vi.mock("../../lib/audioSession", () => ({
  createAudioPlaybackSession: (
    _player: unknown,
    _native: boolean,
    onRequested: (requested: boolean) => void,
  ) => {
    let requested = false;
    audio.onRequested = onRequested;
    return {
      get requested() {
        return requested;
      },
      pause: () => {
        requested = false;
      },
      play: async () => {
        if (!audio.sessionGranted) return;
        requested = true;
        onRequested(true);
      },
    };
  },
  disposeAudioPlayer: (player: { released: boolean }) => {
    player.released = true;
  },
}));

const speech = vi.hoisted(() => ({
  requestSpeech: vi.fn(async (serverUrl: string) => `${serverUrl}/audio/1.mp3`),
}));
vi.mock("./readAloudServer", () => speech);

const dialog = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock("../../components/ui/Dialog", () => dialog);

import {
  getReadAloudState,
  READ_ALOUD_MAX_CHARS,
  startReadAloud,
  stopReadAloud,
  stopReadAloudFor,
} from "./readAloudPlayer";

const reply = (messageId: string, markdown = "Hello there.") => ({
  messageId,
  markdown,
  serverUrl: "http://100.64.0.10:3776",
  voice: "en-US-AvaMultilingualNeural",
});

beforeEach(() => {
  stopReadAloud();
  audio.players.length = 0;
  audio.sessionGranted = true;
  speech.requestSpeech.mockClear();
  dialog.alert.mockClear();
});

describe("startReadAloud", () => {
  it("streams the PC's audio and goes back to idle when it ends", async () => {
    await startReadAloud(reply("m1"));
    expect(audio.players[0]?.url).toBe("http://100.64.0.10:3776/audio/1.mp3");
    expect(getReadAloudState()).toMatchObject({ messageId: "m1", status: "loading" });
    audio.players[0]!.emit({ playing: true });
    expect(getReadAloudState()).toMatchObject({ messageId: "m1", status: "playing" });
    audio.players[0]!.emit({ didJustFinish: true });
    expect(getReadAloudState()).toMatchObject({ messageId: null, status: "idle", error: null });
    expect(audio.players[0]!.released).toBe(true);
  });

  it("doesn't read the options block", async () => {
    await startReadAloud(reply("m1", "Pick one.\n\n```options\nShip it\n```"));
    expect(speech.requestSpeech).toHaveBeenCalledWith(expect.any(String), {
      text: "Pick one.",
      voice: "en-US-AvaMultilingualNeural",
    });
  });

  it("shows a server error once, as a dialog", async () => {
    speech.requestSpeech.mockRejectedValueOnce(new Error("edge-tts failed."));
    await startReadAloud(reply("m1"));
    expect(getReadAloudState()).toMatchObject({
      messageId: "m1",
      status: "idle",
      error: "edge-tts failed.",
    });
    expect(dialog.alert).toHaveBeenCalledTimes(1);
    expect(dialog.alert).toHaveBeenCalledWith("Couldn't read aloud", "edge-tts failed.");
  });

  it("refuses a reply longer than the server takes, before sending it", async () => {
    await startReadAloud(reply("m1", "word ".repeat(READ_ALOUD_MAX_CHARS)));
    expect(speech.requestSpeech).not.toHaveBeenCalled();
    expect(getReadAloudState().error).toMatch(/too long/);
  });

  it("stops when the thread it came from goes away, not another thread", async () => {
    await startReadAloud({ ...reply("m1"), ownerKey: "env:a" });
    stopReadAloudFor("env:b");
    expect(getReadAloudState().status).toBe("loading");
    stopReadAloudFor("env:a");
    expect(getReadAloudState()).toMatchObject({ messageId: null, status: "idle" });
    expect(audio.players[0]!.released).toBe(true);
  });

  it("reports an error when another player keeps the audio session", async () => {
    audio.sessionGranted = false;
    await startReadAloud(reply("m1"));
    expect(getReadAloudState()).toMatchObject({ status: "idle", error: expect.any(String) });
    expect(audio.players[0]!.released).toBe(true);
  });

  it("reports an audio error from the player", async () => {
    await startReadAloud(reply("m1"));
    audio.players[0]!.emit({ error: "Source error" });
    expect(getReadAloudState()).toMatchObject({
      status: "idle",
      error: "The audio couldn't be played.",
    });
  });

  it("replaces the reply that is playing", async () => {
    await startReadAloud(reply("m1"));
    await startReadAloud(reply("m2"));
    expect(audio.players[0]!.released).toBe(true);
    expect(getReadAloudState()).toMatchObject({ messageId: "m2", status: "loading" });
  });

  it("stops when another player takes the audio session", async () => {
    await startReadAloud(reply("m1"));
    audio.onRequested?.(false);
    expect(getReadAloudState()).toMatchObject({ messageId: null, status: "idle", error: null });
  });

  it("needs a server address", async () => {
    await startReadAloud({ ...reply("m1"), serverUrl: null });
    expect(getReadAloudState().error).toMatch(/connection to your PC/);
    expect(speech.requestSpeech).not.toHaveBeenCalled();
  });
});
