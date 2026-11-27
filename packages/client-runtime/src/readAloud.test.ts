import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_READ_ALOUD_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import {
  createReadAloudController,
  createReadAloudWarmup,
  createTimedWords,
  type SpeechPlayback,
  type SpokenWord,
} from "./readAloud.ts";

function deferred<A>() {
  let resolve: (value: A) => void = () => {};
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("stops obsolete requests before they can play and owns only the newest message", async () => {
  const old = deferred<SpeechPlayback>();
  const started = deferred<void>();
  const finished = deferred<void>();
  const stop = vi.fn();
  const obsoletePlay = vi.fn(async () => {});
  const prepare = vi.fn(async (text: string) =>
    text === "first"
      ? old.promise
      : {
          play: async () => {
            started.resolve();
          },
          pause: () => {},
          stop,
          finished: finished.promise,
        },
  );
  const controller = createReadAloudController(prepare);
  const settings = { ...DEFAULT_READ_ALOUD_SETTINGS, provider: "system" as const };
  const first = controller.start("1", "first", settings);
  const second = controller.start("2", "second", settings);
  await started.promise;
  old.resolve({ play: obsoletePlay, pause: () => {}, stop, finished: Promise.resolve() });
  await first;
  expect(obsoletePlay).not.toHaveBeenCalled();
  expect(controller.getSnapshot().id).toBe("2");
  finished.resolve();
  await second;
  expect(controller.getSnapshot().status).toBe("idle");
  expect(stop).toHaveBeenCalledTimes(2);
});

it("pauses without recursive audio-focus callbacks and ignores failures after cancellation", async () => {
  const started = deferred<void>();
  const finished = deferred<void>();
  let controller: ReturnType<typeof createReadAloudController>;
  const pause = vi.fn(() => controller.pause());
  controller = createReadAloudController(async () => ({
    play: async () => {
      started.resolve();
    },
    pause,
    stop: () => finished.resolve(),
    finished: finished.promise,
  }));
  const run = controller.start("1", "reply", {
    ...DEFAULT_READ_ALOUD_SETTINGS,
    provider: "system",
  });
  await started.promise;
  await controller.resume();
  controller.pause();
  expect(pause).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().status).toBe("paused");
  controller.stop();
  await run;
  expect(controller.getSnapshot().status).toBe("idle");
});

it.each(["prepare", "play"])("keeps a pause requested during %s", async (phase) => {
  const preparing = deferred<void>();
  const playing = deferred<void>();
  const release = deferred<void>();
  const finished = deferred<void>();
  const pauseApplied = deferred<void>();
  const pause = vi.fn(() => pauseApplied.resolve());
  const play = vi.fn(async () => {
    playing.resolve();
    if (phase === "play") await release.promise;
  });
  const controller = createReadAloudController(async () => {
    preparing.resolve();
    if (phase === "prepare") await release.promise;
    return { play, pause, stop: () => finished.resolve(), finished: finished.promise };
  });
  const run = controller.start("1", "reply", {
    ...DEFAULT_READ_ALOUD_SETTINGS,
    provider: "system",
  });
  await (phase === "prepare" ? preparing.promise : playing.promise);
  controller.pause();
  expect(controller.getSnapshot().status).toBe("paused");
  release.resolve();
  if (phase === "play") await pauseApplied.promise;
  await controller.resume();
  await playing.promise;
  controller.stop();
  await run;
});

it("keeps a pause across chunk boundaries", async () => {
  const started = deferred<void>();
  const finished = deferred<void>();
  const nextPrepared = deferred<void>();
  const prepare = vi.fn(async () => {
    if (prepare.mock.calls.length > 1) nextPrepared.resolve();
    return {
      play: async () => started.resolve(),
      pause: () => {},
      stop: () => {},
      finished: finished.promise,
    };
  });
  const controller = createReadAloudController(prepare);
  const run = controller.start("1", "word ".repeat(1000), {
    ...DEFAULT_READ_ALOUD_SETTINGS,
    provider: "system",
  });
  await started.promise;
  await controller.resume();
  finished.resolve();
  controller.pause();
  await nextPrepared.promise;
  expect(controller.getSnapshot().status).toBe("paused");
  controller.stop();
  await run;
});

it("does not treat chunk disposal as a pause", async () => {
  const started = deferred<void>();
  const finished = deferred<void>();
  const nextPrepared = deferred<void>();
  let controller: ReturnType<typeof createReadAloudController>;
  const prepare = vi.fn(async () => {
    if (prepare.mock.calls.length > 1) nextPrepared.resolve();
    return {
      play: async () => started.resolve(),
      pause: () => {},
      stop: () => controller.pause(),
      finished: finished.promise,
    };
  });
  controller = createReadAloudController(prepare);
  const run = controller.start("1", "word ".repeat(1000), {
    ...DEFAULT_READ_ALOUD_SETTINGS,
    provider: "system",
  });
  await started.promise;
  finished.resolve();
  await nextPrepared.promise;
  expect(controller.getSnapshot().status).toBe("loading");
  controller.stop();
  await run;
  expect(controller.getSnapshot().status).toBe("idle");
});

it("keeps a new pause while resume activates playback", async () => {
  const playing = deferred<void>();
  const resuming = deferred<void>();
  const activated = deferred<void>();
  const finished = deferred<void>();
  const play = vi.fn(async () => {
    if (play.mock.calls.length === 1) return;
    else {
      resuming.resolve();
      await activated.promise;
    }
  });
  const controller = createReadAloudController(async () => ({
    play,
    pause: () => {},
    stop: () => finished.resolve(),
    finished: finished.promise,
  }));
  const unsubscribe = controller.subscribe(() => {
    if (controller.getSnapshot().status === "playing") playing.resolve();
  });
  const run = controller.start("resume", "reply", {
    ...DEFAULT_READ_ALOUD_SETTINGS,
    provider: "system",
  });
  await playing.promise;
  controller.pause();
  const resume = controller.resume();
  await resuming.promise;
  try {
    expect(controller.getSnapshot().status).toBe("loading");
    controller.pause();
    activated.resolve();
    await resume;
    expect(controller.getSnapshot().status).toBe("paused");
  } finally {
    activated.resolve();
    controller.stop();
    await resume;
    await run;
    unsubscribe();
  }
});

it("warms each local model once per interval, and again after a failed request", async () => {
  let now = 0;
  const failed = deferred<void>();
  const warm = vi.fn(async (_environment: EnvironmentId, model: string) => {
    if (model === "broken") {
      failed.resolve();
      throw new Error("offline");
    }
  });
  const warmup = createReadAloudWarmup(warm, () => now);
  const environmentId = EnvironmentId.make("env");
  const local = { ...DEFAULT_READ_ALOUD_SETTINGS, provider: "local" as const, environmentId };
  warmup(local);
  warmup(local);
  warmup({ ...local, provider: "xai" });
  warmup({ ...local, environmentId: null });
  expect(warm.mock.calls).toEqual([[environmentId, local.model]]);
  now = 4 * 60_000;
  warmup(local);
  warmup({ ...local, model: "broken" });
  await failed.promise;
  await Promise.resolve();
  warmup({ ...local, model: "broken" });
  expect(warm.mock.calls.map(([, model]) => model)).toEqual([
    local.model,
    local.model,
    "broken",
    "broken",
  ]);
});

it("highlights the spoken word by its markdown range, across chunks, while highlighting is on", async () => {
  const markdown = `Intro **bold** words.\n\n${"filler ".repeat(520)}\n\nLast \`code\` part.`;
  const emit: Array<(word: SpokenWord | null) => void> = [];
  // The intro, the filler up to the limit, and the rest.
  const finished = [deferred<void>(), deferred<void>(), deferred<void>()];
  const playing = [deferred<void>(), deferred<void>(), deferred<void>()];
  const texts: string[] = [];
  const controller = createReadAloudController(async (text) => {
    const index = texts.push(text) - 1;
    return {
      play: async () => playing[index]?.resolve(),
      pause: () => {},
      stop: () => {},
      finished: finished[index]?.promise ?? Promise.resolve(),
      words: (listener) => {
        emit[index] = listener;
        return () => {
          delete emit[index];
        };
      },
    };
  });
  const settings = { ...DEFAULT_READ_ALOUD_SETTINGS, provider: "system" as const };
  const run = controller.start("1", markdown, settings);
  await playing[0]?.promise;
  const bold = texts[0]!.indexOf("bold");
  emit[0]?.({ start: bold, end: bold + 4 });
  expect(controller.getHighlight()).toMatchObject({
    id: "1",
    word: { start: markdown.indexOf("bold"), end: markdown.indexOf("bold") + 4 },
    block: { start: 0, first: { text: "Intro" }, last: { text: "words." } },
  });
  finished[0]?.resolve();
  await playing[1]?.promise;
  expect(controller.getHighlight()).toBeNull();
  finished[1]?.resolve();
  await playing[2]?.promise;
  const code = texts[2]!.indexOf("code");
  emit[2]?.({ start: code, end: code + 4 });
  expect(controller.getHighlight()?.word).toMatchObject({
    start: markdown.indexOf("code"),
    cue: { text: "code", occurrence: 0 },
  });
  controller.stop();
  expect(controller.getHighlight()).toBeNull();
  expect(emit.filter(Boolean)).toHaveLength(0);
  await run;
});

it("starts at the block a user picks, keeps its markdown offsets, and ignores a place after the last block", async () => {
  const markdown = "First paragraph.\n\nSecond **bold** one.\n\n```sh\nls\n```";
  const texts: string[] = [];
  let emit: ((word: SpokenWord | null) => void) | undefined;
  const playing = deferred<void>();
  const finished = deferred<void>();
  const controller = createReadAloudController(async (text) => {
    texts.push(text);
    return {
      play: async () => playing.resolve(),
      pause: () => {},
      stop: () => finished.resolve(),
      finished: finished.promise,
      words: (listener) => {
        emit = listener;
        return () => {
          emit = undefined;
        };
      },
    };
  });
  const settings = { ...DEFAULT_READ_ALOUD_SETTINGS, provider: "system" as const };
  const run = controller.start("1", markdown, settings, markdown.indexOf("bold"));
  await playing.promise;
  expect(texts).toEqual(["Second bold one."]);
  emit?.({ start: 7, end: 11 });
  expect(controller.getHighlight()).toMatchObject({
    word: { start: markdown.indexOf("bold"), end: markdown.indexOf("bold") + 4 },
    block: { start: markdown.indexOf("Second"), first: { text: "Second" } },
  });

  // Only the reply being read jumps, and a skipped code block holds nothing to read.
  expect(controller.isReading("1")).toBe(true);
  expect(controller.jump("2", 0)).toBeNull();
  await controller.jump("1", markdown.indexOf("ls"));
  expect(texts).toHaveLength(1);
  expect(controller.getSnapshot()).toMatchObject({ id: "1", status: "playing" });

  // A jump reads the same reply again with the same settings, from the block picked.
  const jumped = controller.jump("1", 0);
  await run;
  await vi.waitFor(() =>
    expect(texts).toEqual(["Second bold one.", "First paragraph.\nSecond bold one."]),
  );
  controller.stop();
  await jumped;
  expect(controller.isReading("1")).toBe(false);
  expect(controller.jump("1", 0)).toBeNull();
});

it("seeks to a picked word in the audio when its time is known, else reads from that word", async () => {
  const markdown = "First paragraph here.\n\nSecond **bold** one.";
  const texts: string[] = [];
  const froms: Array<number | undefined> = [];
  const seeks: number[] = [];
  const speeds: number[] = [];
  let seekable = true;
  let estimated = false;
  const prepared: Array<ReturnType<typeof deferred<void>>> = [];
  const controller = createReadAloudController(async (text, _settings, _signal, from) => {
    texts.push(text);
    froms.push(from);
    const finished = deferred<void>();
    prepared.push(finished);
    return {
      play: async () => {},
      pause: () => {},
      stop: () => finished.resolve(),
      finished: finished.promise,
      seek: (at) => {
        seeks.push(at);
        return seekable;
      },
      estimated: () => estimated,
      setSpeed: (speed) => speeds.push(speed),
    };
  });
  const settings = { ...DEFAULT_READ_ALOUD_SETTINGS, provider: "local" as const };
  void controller.start("1", markdown, settings);
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe("playing"));
  expect(controller.seek("2", 0)).toBeNull();

  // "bold" sits at offset 29 of the spoken text "First paragraph here.\nSecond bold one."
  await controller.seek("1", markdown.indexOf("old"));
  expect(seeks).toEqual(["First paragraph here.\nSecond ".length]);
  expect(texts).toHaveLength(1);

  // A word whose time has not arrived is read again: from its sentence's start for context, with
  // the audio starting at the word itself.
  seekable = false;
  void controller.seek("1", markdown.indexOf("one"));
  await vi.waitFor(() => expect(texts).toEqual([texts[0], "Second bold one."]));
  expect(froms).toEqual([undefined, "Second bold ".length]);

  // The lead-in is not in that audio, so a word in it is read again rather than sought.
  seekable = true;
  seeks.length = 0;
  void controller.seek("1", markdown.indexOf("Second"));
  await vi.waitFor(() => expect(texts).toHaveLength(3));
  expect(seeks).toEqual([]);
  expect(froms[2]).toBeUndefined();

  // Speech the environment could not time would play its lead-in whole, so it starts at the word.
  estimated = true;
  seekable = false;
  void controller.seek("1", markdown.indexOf("one"));
  await vi.waitFor(() => expect(texts).toHaveLength(4));
  expect(texts[3]).toBe("one.");
  expect(froms[3]).toBeUndefined();
  estimated = false;

  // Speed changes go to the player, and later readings keep them.
  await controller.setSpeed(1.25);
  expect(speeds).toEqual([1.25]);
  controller.stop();
  expect(controller.setSpeed(1.5)).toBeNull();
});

it("follows the environment's word timings on the audio clock and estimates them when there are none", async () => {
  vi.useFakeTimers();
  try {
    let seconds = 0;
    const clock = () => ({ seconds, rate: 2, playing: true });
    const words = [
      { start: 0, end: 3, startSeconds: 0, endSeconds: 1 },
      { start: 4, end: 7, startSeconds: 1, endSeconds: 2 },
    ];
    const provider = createTimedWords({
      text: "one two",
      load: async () => ({ words, done: true }),
      clock,
    });
    const heard: Array<SpokenWord | null> = [];
    provider.subscribe((word) => heard.push(word));
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toEqual([{ start: 0, end: 3 }]);
    seconds = 1;
    // At 2× the next word starts after half a second of wall time, less a little slack.
    await vi.advanceTimersByTimeAsync(469);
    expect(heard).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(heard).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    // A seek that lands a few milliseconds short of a word, as MP3 seeks do, is on that word.
    seconds = 0.5;
    provider.refresh();
    seconds = 0.98;
    provider.refresh();
    expect(heard.at(-1)).toEqual({ start: 4, end: 7 });
    expect(provider.secondsAt(5)).toBe(1);
    provider.stop();

    seconds = 2.5;
    const estimated = createTimedWords({
      text: "one two three.",
      load: async () => ({ words: [], done: true, durationSeconds: 3 }),
      clock,
    });
    const guessed: Array<SpokenWord | null> = [];
    estimated.subscribe((word) => guessed.push(word));
    await vi.advanceTimersByTimeAsync(0);
    expect(guessed).toEqual([{ start: 8, end: 14 }]);
    // Estimated times only highlight; a seek reads again from the word instead of guessing.
    expect(estimated.secondsAt(4)).toBeUndefined();
    estimated.stop();
  } finally {
    vi.useRealTimers();
  }
});
