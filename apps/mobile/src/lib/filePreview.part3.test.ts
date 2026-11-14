import { audio } from "./filePreviewAudioMocks.testkit";
import {
  act,
  createElement,
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { inlineFilePreviewKind, isPdfFile } from "./filePreview";
import { ThreadInlineFilePreview } from "../features/threads/ThreadInlineFilePreview";
import { AudioFilePreview } from "../features/files/AudioFilePreview";
import { MediaVideoPlayer } from "../components/MediaVideoPlayer";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { acquireAudioSession, activateAudioSession, releaseAudioSession } from "./audioSession";
import { ThreadFeed } from "../features/threads/ThreadFeed";
import type { ThreadFeedEntry } from "./threadActivity";
import type { MarkdownImageRenderer } from "../native/SelectableMarkdownText";
describe("ThreadInlineFilePreview playback", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  beforeEach(() => {
    audio.sessionOwned = false;
    audio.setSessionOwner.mockImplementation((owned) => {
      audio.sessionOwned = owned;
    });
    audio.player.pause.mockReset();
    audio.enabled = true;
    audio.setActive.mockImplementation(async (enabled) => {
      audio.enabled = enabled;
    });
    // Expo's play() silently does nothing while its global gate is disabled.
    audio.player.play.mockImplementation(() => {
      if (audio.enabled) audio.played();
    });
    audio.video.addListener.mockImplementation(
      (event: string, listener: (event: { isPlaying: boolean }) => void) => {
        if (event === "playbackRequestedChange") {
          const requestListener = listener as unknown as (event: {
            isPlaybackRequested: boolean;
          }) => void;
          audio.videoRequestListeners.add(requestListener);
          return { remove: () => audio.videoRequestListeners.delete(requestListener) };
        }
        if (event === "statusChange") {
          const statusListener = listener as unknown as (event: { status: string }) => void;
          audio.videoStatusListeners.add(statusListener);
          return { remove: () => audio.videoStatusListeners.delete(statusListener) };
        }
        if (event === "playToEnd") {
          const endListener = listener as unknown as () => void;
          audio.videoEndListeners.add(endListener);
          return { remove: () => audio.videoEndListeners.delete(endListener) };
        }
        audio.videoListeners.add(listener);
        return { remove: () => audio.videoListeners.delete(listener) };
      },
    );
    audio.video.play.mockImplementation(() => {
      audio.video.playing = true;
      audio.video.playbackRequested = true;
      for (const listener of audio.videoRequestListeners) listener({ isPlaybackRequested: true });
      for (const listener of audio.videoListeners) listener({ isPlaying: audio.video.playing });
    });
    audio.video.pause.mockImplementation(() => {
      const wasRequested = audio.video.playbackRequested;
      const wasPlaying = audio.video.playing;
      audio.video.playbackRequested = false;
      audio.video.playing = false;
      if (wasRequested) {
        for (const listener of audio.videoRequestListeners)
          listener({ isPlaybackRequested: false });
      }
      if (wasPlaying) {
        for (const listener of audio.videoListeners) listener({ isPlaying: false });
      }
    });
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    vi.clearAllMocks();
    audio.refresh.mockReset();
    audio.setAudioMode.mockReset();
    audio.setActive.mockReset();
    audio.video.status = "readyToPlay";
    audio.status = {
      playing: false,
      isLoaded: false,
      error: null,
      didJustFinish: false,
      currentTime: 0,
      duration: 10,
      isBuffering: false,
    };
  });

  it("plays inline, opens the file viewer, and yields viewer playback to recording", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    audio.status = { ...audio.status, isLoaded: true };
    const container = document.createElement("div");
    root = createRoot(container);
    const openViewer = () =>
      root!.render(
        createElement(AudioFilePreview, { uri: "https://example.com/sound.mp3", onRetry() {} }),
      );
    await act(async () =>
      root!.render(
        createElement(ThreadInlineFilePreview, {
          source: { kind: "document", name: "sound.mp3", uri: "https://example.com/sound.mp3" },
          onOpen: openViewer,
        }),
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!.click(),
    );
    expect(audio.played).toHaveBeenCalledOnce();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Open sound.mp3"]')!.click(),
    );
    expect(audio.enabled).toBe(true);
    const play = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Play",
    )!;
    await act(async () => play.click());
    expect(audio.played).toHaveBeenCalledTimes(2);
    audio.player.pause.mockClear();
    let recording!: ReturnType<typeof acquireAudioSession>;
    await act(async () => {
      recording = acquireAudioSession("recording");
    });
    expect(audio.player.pause).toHaveBeenCalledOnce();
    await activateAudioSession(recording);
    await act(async () => play.click());
    expect(audio.played).toHaveBeenCalledTimes(2);
    await releaseAudioSession(recording);
    await act(async () => play.click());
    expect(audio.played).toHaveBeenCalledTimes(3);
    expect(audio.enabled).toBe(true);
  });

  it.each(["pause", "unmount", "recording"])(
    "does not restart the file viewer after %s during replay seeking",
    async (action) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      audio.status = { ...audio.status, isLoaded: true, didJustFinish: true, currentTime: 10 };
      const seek = Promise.withResolvers<void>();
      audio.player.seekTo.mockReturnValueOnce(seek.promise);
      const container = document.createElement("div");
      root = createRoot(container);
      await act(async () =>
        root!.render(
          createElement(AudioFilePreview, { uri: "https://example.com/sound.mp3", onRetry() {} }),
        ),
      );
      const play = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Play",
      )!;
      await act(async () => play.click());
      expect(play.textContent).toBe("Pause");
      let recording: ReturnType<typeof acquireAudioSession> | undefined;
      if (action === "pause") await act(async () => play.click());
      else if (action === "recording") {
        await act(async () => {
          recording = acquireAudioSession("recording");
        });
        expect(play.textContent).toBe("Play");
        await activateAudioSession(recording!);
      } else {
        await act(async () => root!.unmount());
        root = undefined;
      }
      await act(async () => seek.resolve());
      expect(audio.played).not.toHaveBeenCalled();
      if (recording) await releaseAudioSession(recording);
    },
  );

  it.each(["buffering", "seek"])(
    "keeps file viewer ownership through %s and native resume",
    async (transition) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      audio.status = { ...audio.status, isLoaded: true };
      const container = document.createElement("div");
      root = createRoot(container);
      const render = () =>
        root!.render(
          createElement(AudioFilePreview, {
            uri: "https://example.com/sound.mp3",
            onRetry() {},
          }),
        );
      await act(async () => render());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Play")!
          .click(),
      );
      audio.status = { ...audio.status, playing: true };
      await act(async () => render());
      audio.player.pause.mockClear();
      if (transition === "seek") {
        await act(async () =>
          [...container.querySelectorAll("button")]
            .find((button) => button.textContent === "+15s")!
            .click(),
        );
        expect(audio.player.seekTo).toHaveBeenCalledWith(10);
      }
      audio.status = { ...audio.status, playing: false, isBuffering: transition === "buffering" };
      await act(async () => render());
      expect(audio.player.pause).not.toHaveBeenCalled();
      expect(
        [...container.querySelectorAll("button")].map((button) => button.textContent),
      ).toContain("Pause");
      audio.status = { ...audio.status, playing: true, isBuffering: false };
      await act(async () => render());
      expect(audio.played).toHaveBeenCalledOnce();
      let recording!: ReturnType<typeof acquireAudioSession>;
      await act(async () => {
        recording = acquireAudioSession("recording");
      });
      expect(audio.player.pause).toHaveBeenCalledOnce();
      await releaseAudioSession(recording);
    },
  );

  it.each(["pause", "pause while buffering", "pause while loading", "end", "error"])(
    "releases file viewer ownership on %s",
    async (action) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      audio.status = { ...audio.status, isLoaded: true };
      const container = document.createElement("div");
      root = createRoot(container);
      const render = () =>
        root!.render(
          createElement(AudioFilePreview, {
            uri: "https://example.com/sound.mp3",
            onRetry() {},
          }),
        );
      await act(async () => render());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Play")!
          .click(),
      );
      audio.status = { ...audio.status, playing: true };
      await act(async () => render());
      if (action.startsWith("pause")) {
        if (action !== "pause") {
          audio.status = {
            ...audio.status,
            playing: false,
            isBuffering: true,
            isLoaded: action !== "pause while loading",
          };
          await act(async () => render());
        }
        await act(async () =>
          [...container.querySelectorAll("button")]
            .find((button) => button.textContent === "Pause")!
            .click(),
        );
      } else {
        audio.status = { ...audio.status, playing: false, didJustFinish: action === "end" };
        if (action === "error") Object.assign(audio.status, { error: "Playback failed" });
        await act(async () => render());
      }
      expect(audio.player.pause).toHaveBeenLastCalledWith();
      audio.status = { ...audio.status, playing: false, isBuffering: false, isLoaded: true };
      await act(async () => render());
      expect(
        [...container.querySelectorAll("button")].map((button) => button.textContent),
      ).toContain("Play");
      audio.player.pause.mockClear();
      const recording = acquireAudioSession("recording");
      expect(audio.player.pause).not.toHaveBeenCalled();
      expect(audio.setActive).not.toHaveBeenCalledWith(false);
      await releaseAudioSession(recording);
    },
  );

  it.each(["buffering", "seek"])(
    "keeps video ownership through %s and resume, including recording takeover during the next wait",
    async (transition) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      root = createRoot(document.createElement("div"));
      await act(async () =>
        root!.render(
          createElement(MediaVideoPlayer, {
            uri: "https://example.com/clip.mp4",
            name: "clip.mp4",
            thumbnailKey: "clip",
            expanded: true,
            autoPlay: true,
          }),
        ),
      );
      audio.video.pause.mockClear();
      // iOS can keep readyToPlay during a seek's evaluatingBufferingRate wait.
      if (transition === "buffering") {
        audio.video.status = "loading";
        for (const listener of audio.videoStatusListeners) listener({ status: "loading" });
      }
      audio.video.playing = false;
      for (const listener of audio.videoListeners) listener({ isPlaying: false });
      expect(audio.video.pause).not.toHaveBeenCalled();
      // Buffer readiness can precede the native playing=true event.
      audio.video.status = "readyToPlay";
      for (const listener of audio.videoStatusListeners) listener({ status: "readyToPlay" });
      expect(audio.video.pause).not.toHaveBeenCalled();
      audio.video.playing = true;
      for (const listener of audio.videoListeners) listener({ isPlaying: true });
      expect(audio.video.play).toHaveBeenCalledOnce();
      audio.video.playing = false;
      for (const listener of audio.videoListeners) listener({ isPlaying: false });
      const recording = acquireAudioSession("recording");
      expect(audio.video.pause).toHaveBeenCalledOnce();
      audio.video.play();
      expect(audio.video.playing).toBe(false);
      await releaseAudioSession(recording);
      audio.video.play();
      expect(audio.video.playing).toBe(true);
    },
  );

  it.each(["pause", "pause while buffering", "end", "error"])(
    "releases video ownership on %s",
    async (action) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      root = createRoot(document.createElement("div"));
      await act(async () =>
        root!.render(
          createElement(MediaVideoPlayer, {
            uri: "https://example.com/clip.mp4",
            name: "clip.mp4",
            thumbnailKey: "clip",
            expanded: true,
            autoPlay: true,
          }),
        ),
      );
      await act(async () => {
        if (action.startsWith("pause")) {
          if (action === "pause while buffering") {
            audio.video.status = "loading";
            audio.video.playing = false;
            for (const listener of audio.videoListeners) listener({ isPlaying: false });
          }
          audio.video.pause();
        } else if (action === "end") {
          for (const listener of audio.videoEndListeners) listener();
        } else {
          audio.video.status = "error";
          for (const listener of audio.videoStatusListeners) listener({ status: "error" });
        }
      });
      audio.video.pause.mockClear();
      const recording = acquireAudioSession("recording");
      expect(audio.video.pause).not.toHaveBeenCalled();
      await releaseAudioSession(recording);
    },
  );

  it("keeps thread video playback and native controls working after audio releases", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const recording = acquireAudioSession("recording");
    await activateAudioSession(recording);
    await releaseAudioSession(recording);
    const modes = audio.setAudioMode.mock.calls.length;
    const activations = audio.setActive.mock.calls.length;
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(MediaVideoPlayer, {
          uri: "https://example.com/clip.mp4",
          name: "clip.mp4",
          thumbnailKey: "clip",
          expanded: true,
          autoPlay: true,
        }),
      ),
    );
    expect(audio.video.playing).toBe(true);
    expect(audio.setAudioMode).toHaveBeenCalledTimes(modes);
    expect(audio.setActive).toHaveBeenCalledTimes(activations);
    audio.video.pause();
    audio.video.play();
    expect(audio.video.playing).toBe(true);
    const takeover = acquireAudioSession("recording");
    expect(audio.video.playing).toBe(false);
    await activateAudioSession(takeover);
    audio.video.play();
    expect(audio.video.playing).toBe(false);
    await releaseAudioSession(takeover);
    audio.video.play();
    expect(audio.video.playing).toBe(true);
    await act(async () => root!.unmount());
    root = undefined;
    expect(audio.video.playing).toBe(false);
  });

  it.each(["play", "cancel", "unmount", "mode failure", "activation failure"])(
    "reactivates audio after voice release and honors %s during activation",
    async (intent) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const recording = acquireAudioSession("recording");
      await activateAudioSession(recording);
      await releaseAudioSession(recording);
      vi.clearAllMocks();
      let activate: () => void = () => {};
      if (intent === "mode failure") {
        audio.setAudioMode.mockRejectedValueOnce(new Error("Playback mode unavailable"));
      } else if (intent === "activation failure") {
        audio.setActive.mockRejectedValueOnce(new Error("Audio session unavailable"));
      } else {
        audio.setActive.mockImplementationOnce(
          () => new Promise((resolve) => (activate = resolve)),
        );
      }
      audio.status = { ...audio.status, isLoaded: true };
      const container = document.createElement("div");
      root = createRoot(container);
      act(() =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: { kind: "document", name: "sound.mp3", uri: "https://example.com/sound.mp3" },
            onOpen() {},
          }),
        ),
      );
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      expect(audio.setAudioMode).toHaveBeenLastCalledWith({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
      });
      expect(audio.player.play).not.toHaveBeenCalled();
      if (intent.endsWith("failure")) {
        expect(container.textContent).toContain("Unavailable · tap play to retry");
        expect(button.getAttribute("aria-label")).toBe("Retry audio");
        expect(audio.setActive).not.toHaveBeenCalledWith(false);
        return;
      }
      expect(audio.setActive).toHaveBeenLastCalledWith(true);
      expect(audio.setAudioMode.mock.invocationCallOrder[0]).toBeLessThan(
        audio.setActive.mock.invocationCallOrder[0]!,
      );
      if (intent === "cancel") await act(async () => button.click());
      else if (intent === "unmount") {
        act(() => root!.unmount());
        root = undefined;
        expect(audio.player.release).not.toHaveBeenCalled();
      }
      await act(async () => activate());
      if (intent === "play") {
        expect(audio.player.play).toHaveBeenCalledOnce();
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
      } else {
        expect(audio.player.play).not.toHaveBeenCalled();
        expect(audio.setActive).toHaveBeenLastCalledWith(true);
        expect(audio.player.pause).toHaveBeenCalled();
        if (intent === "unmount") {
          expect(audio.player.release).toHaveBeenCalledOnce();
          expect(audio.player.pause.mock.invocationCallOrder[0]).toBeLessThan(
            audio.player.release.mock.invocationCallOrder[0]!,
          );
        }
        if (intent === "cancel") expect(button.getAttribute("aria-label")).toBe("Play audio");
      }
    },
  );

  it.each(["playing", "URL pending", "mode pending", "activation pending"])(
    "yields to recording while %s and plays again after recording stops",
    async (phase) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const url = Promise.withResolvers<string>();
      const native = Promise.withResolvers<void>();
      audio.refresh.mockReturnValueOnce(url.promise);
      audio.status = { ...audio.status, isLoaded: phase !== "URL pending" };
      if (phase === "mode pending") audio.setAudioMode.mockReturnValueOnce(native.promise);
      if (phase === "activation pending") audio.setActive.mockReturnValueOnce(native.promise);
      const container = document.createElement("div");
      root = createRoot(container);
      act(() =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: {
              kind: "document",
              name: "sound.mp3",
              environmentId: EnvironmentId.make("environment-1"),
              resource: {
                _tag: "workspace-file",
                threadId: ThreadId.make("thread-1"),
                path: "/repo/sound.mp3",
              },
            },
            onOpen() {},
          }),
        ),
      );
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      expect(audio.player.play).toHaveBeenCalledTimes(phase === "playing" ? 1 : 0);
      expect(audio.refresh).toHaveBeenCalledTimes(phase === "URL pending" ? 1 : 0);
      let recording!: ReturnType<typeof acquireAudioSession>;
      await act(async () => {
        recording = acquireAudioSession("recording");
      });
      expect(audio.player.pause).toHaveBeenCalled();
      expect(button.getAttribute("aria-label")).toBe("Play audio");
      native.resolve();
      await activateAudioSession(recording);
      expect(audio.setAudioMode).toHaveBeenLastCalledWith({
        allowsRecording: true,
        interruptionMode: "doNotMix",
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      const modeCalls = audio.setAudioMode.mock.calls.length;
      const activationCalls = audio.setActive.mock.calls.length;
      await act(async () => url.resolve("https://example.com/sound.mp3"));
      await act(async () => button.click());
      expect(audio.setAudioMode).toHaveBeenCalledTimes(modeCalls);
      expect(audio.setActive).toHaveBeenCalledTimes(activationCalls);
      expect(audio.setActive).not.toHaveBeenCalledWith(false);
      expect(audio.player.play).toHaveBeenCalledTimes(phase === "playing" ? 1 : 0);
      await releaseAudioSession(recording);
      audio.status = { ...audio.status, isLoaded: true };
      // Refresh the native status before the next tap.
      await act(async () =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: { kind: "document", name: "sound.mp3", uri: "https://example.com/sound.mp3" },
            onOpen() {},
          }),
        ),
      );
      const replay = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => replay.click());
      expect(audio.player.play).toHaveBeenCalledTimes(phase === "playing" ? 2 : 1);
      expect(audio.setAudioMode).toHaveBeenLastCalledWith({
        allowsRecording: false,
        interruptionMode: "doNotMix",
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      expect(audio.setActive).toHaveBeenLastCalledWith(true);
    },
  );

  it.each(["cancel", "unmount", "replay, stale first", "replay, latest first"])(
    "honors the latest audio intent after %s during URL resolution",
    async (intent) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const container = document.createElement("div");
      root = createRoot(container);
      const resolutions: Array<(uri: string) => void> = [];
      audio.refresh.mockImplementation(() => new Promise((resolve) => resolutions.push(resolve)));
      act(() =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: {
              kind: "document",
              name: "sound.mp3",
              environmentId: EnvironmentId.make("environment-1"),
              resource: {
                _tag: "workspace-file",
                threadId: ThreadId.make("thread-1"),
                path: "/repo/sound.mp3",
              },
            },
            onOpen() {},
          }),
        ),
      );
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      if (intent !== "unmount") {
        await act(async () => button.click());
        expect(button.getAttribute("aria-label")).toBe("Play audio");
      }
      const replay = intent.startsWith("replay");
      if (replay) {
        await act(async () => button.click());
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
        expect(audio.refresh).toHaveBeenCalledTimes(2);
      } else if (intent === "unmount") {
        act(() => root!.unmount());
        root = undefined;
      }
      const latestFirst = intent === "replay, latest first";
      if (latestFirst) await act(async () => resolutions[1]!("https://example.com/latest.mp3"));
      await act(async () => resolutions[0]!("https://example.com/stale.mp3"));
      expect(audio.player.play).toHaveBeenCalledTimes(latestFirst ? 1 : 0);
      expect(audio.player.replace).toHaveBeenCalledTimes(latestFirst ? 1 : 0);
      if (replay) {
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
        if (!latestFirst) {
          expect(container.textContent).toContain("Loading…");
          await act(async () => resolutions[1]!("https://example.com/latest.mp3"));
        }
        expect(audio.player.replace).toHaveBeenCalledExactlyOnceWith({
          uri: "https://example.com/latest.mp3",
        });
        expect(audio.player.play).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])(
    "cancels a second tap while buffering with isLoaded=%s",
    async (isLoaded) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const container = document.createElement("div");
      root = createRoot(container);
      audio.status = { ...audio.status, isLoaded, isBuffering: isLoaded };
      let resolve: (uri: string) => void = () => {};
      audio.refresh.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const preview = createElement(ThreadInlineFilePreview, {
        source: {
          kind: "document",
          name: "sound.mp3",
          environmentId: EnvironmentId.make("environment-1"),
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "/repo/sound.mp3",
          },
        },
        onOpen() {},
      });
      act(() => root!.render(preview));
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 1 : 0);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-label")).toBe("Pause audio");
      expect(button.getAttribute("aria-busy")).toBe("true");
      await act(async () => button.click());
      expect(audio.player.pause).toHaveBeenCalled();
      expect(button.getAttribute("aria-label")).toBe("Play audio");
      expect(button.getAttribute("aria-busy")).toBe("false");
      if (!isLoaded) await act(async () => resolve("https://example.com/sound.mp3"));
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 1 : 0);
      if (!isLoaded) {
        expect(audio.player.replace).not.toHaveBeenCalled();
        audio.refresh.mockResolvedValue("https://example.com/sound.mp3");
      }
      await act(async () => button.click());
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 2 : 1);
      audio.status = { ...audio.status, isLoaded: true, didJustFinish: true, currentTime: 10 };
      await act(async () =>
        root!.render(createElement(ThreadInlineFilePreview, { ...preview.props })),
      );
      expect(button.getAttribute("aria-label")).toBe("Play audio");
      await act(async () => button.click());
      expect(audio.player.seekTo).toHaveBeenCalledWith(0);
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 3 : 2);
    },
  );
});
