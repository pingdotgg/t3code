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

  it.each(
    (["user", "assistant"] as const).flatMap((role) =>
      (["attachment", "markdown"] as const).flatMap((origin) =>
        (["audio", "video"] as const).flatMap((kind) =>
          (kind === "video"
            ? ["initial play", "native resume", "continued playback"]
            : ["initial play"]
          ).map((playback) => ({
            role,
            origin,
            kind,
            playback,
            outcome: playback === "continued playback" ? "preserves" : "cancels",
          })),
        ),
      ),
    ),
  )(
    "$outcome a pending file lookup on $role $origin $kind $playback",
    async ({ role, origin, kind, playback }) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const environmentId = EnvironmentId.make("environment-1");
      const threadId = ThreadId.make("thread-1");
      const messageId = MessageId.make("message-1");
      const timestamp = "2026-10-20T00:00:00.000Z";
      const name = kind === "audio" ? "clip.mp3" : "clip.mp4";
      const mimeType = kind === "audio" ? "audio/mpeg" : "video/mp4";
      const uri = `https://example.com/${name}`;
      const feed: ThreadFeedEntry[] = [
        {
          type: "message",
          id: messageId,
          createdAt: timestamp,
          message: {
            id: messageId,
            role,
            text: `open target.ts${origin === "markdown" ? `\n\n![${name}](${uri})` : ""}`,
            attachments:
              origin === "attachment"
                ? [{ type: "file", id: "clip", name, mimeType, sizeBytes: 12 }]
                : [],
            createdAt: timestamp,
            updatedAt: timestamp,
            runId: null,
            streaming: false,
            visibility: "local",
            sourceThreadId: threadId,
          },
        },
      ];
      let finishLookup!: (value: unknown) => void;
      const lookup = new Promise((resolve) => {
        finishLookup = resolve;
      });
      audio.query
        .mockResolvedValue({ _tag: "Success", value: { kind: "file" } })
        .mockReturnValueOnce(lookup);
      audio.refresh.mockResolvedValue(uri);
      const container = document.createElement("div");
      root = createRoot(container);
      await act(async () =>
        root!.render(
          createElement(ThreadFeed, {
            environmentId,
            threadId,
            detailRef: null,
            threadTitle: "preview",
            workspaceRoot: "/repo",
            feed,
            queuedMessages: [],
            dispatchingMessageId: null,
            onEditPendingMessage: null,
            contentPresentation: { kind: "ready" },
            latestRun: null,
            activeWorkStartedAt: null,
            listRef: { current: null },
            freeze: { value: false } as Parameters<typeof ThreadFeed>[0]["freeze"],
            contentInsetEndAdjustment: { value: 0 } as Parameters<
              typeof ThreadFeed
            >[0]["contentInsetEndAdjustment"],
            anchorMessageId: null,
            keyboardOffset: 0,
          }),
        ),
      );
      const link = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("open target.ts"),
      )!;
      const playLabel = kind === "audio" ? "Play audio" : `Play ${name}`;
      const play = () =>
        container.querySelector<HTMLButtonElement>(`[aria-label="${playLabel}"]`)!.click();
      if (playback !== "initial play") {
        await act(async () => play());
        expect(audio.video.playing).toBe(true);
        if (playback === "native resume") {
          await act(async () => audio.video.pause());
          expect(audio.video.playing).toBe(false);
        } else {
          await act(async () => {
            for (const listener of audio.videoRequestListeners)
              listener({ isPlaybackRequested: true });
          });
        }
      }
      await act(async () => link.click());
      const signal: AbortSignal = audio.query.mock.calls[0]![2].signal;
      expect(signal.aborted).toBe(false);
      expect(audio.navigate).not.toHaveBeenCalled();
      await act(async () => {
        if (playback === "native resume") {
          // Native resume requests playback before buffering advances the clock.
          audio.video.playbackRequested = true;
          for (const listener of audio.videoRequestListeners)
            listener({ isPlaybackRequested: true });
          expect(audio.video.playing).toBe(false);
        } else if (playback === "continued playback") {
          for (const isPlaying of [false, true, false, true]) {
            audio.video.playing = isPlaying;
            for (const listener of audio.videoListeners) listener({ isPlaying });
            for (const listener of audio.videoRequestListeners)
              listener({ isPlaybackRequested: true });
          }
          expect(signal.aborted).toBe(false);
        } else play();
      });
      expect(kind === "audio" ? audio.played : audio.video.play).toHaveBeenCalled();
      expect(audio.sessionOwned).toBe(true);
      await act(async () =>
        finishLookup({
          _tag: "Success",
          value: { entries: [{ path: "src/target.ts", kind: "file" }] },
        }),
      );
      if (playback === "continued playback") {
        expect(audio.navigate).toHaveBeenCalledExactlyOnceWith("ThreadFile", {
          environmentId,
          threadId,
          path: ["src", "target.ts"],
        });
        expect(signal.aborted).toBe(false);
      } else {
        expect(audio.navigate).not.toHaveBeenCalled();
        expect(signal.aborted).toBe(true);
      }
      expect(container.querySelector(`[aria-label="${playLabel}"]`)).toBeNull();
      if (kind === "audio")
        expect(container.querySelector('[aria-label="Pause audio"]')).not.toBeNull();
      else {
        if (playback === "native resume") {
          audio.video.playing = true;
          for (const listener of audio.videoListeners) listener({ isPlaying: true });
        }
        expect(audio.video.playing).toBe(true);
      }
    },
  );

  it.each(
    ["takeover", "pause", "finish"].flatMap((release) => [
      ["inline", "video", release],
      ["viewer", "video", release],
      ["inline", "native video controls", release],
      ["viewer", "native video controls", release],
      ["inline", "recording", release],
      ["viewer", "recording", release],
    ]),
  )(
    "keeps the shared session active when %s audio yields to %s after %s",
    async (source, successor, release) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      audio.status = { ...audio.status, isLoaded: true };
      const container = document.createElement("div");
      root = createRoot(container);
      const render = (playVideo = false, showAudio = true) =>
        root!.render(
          createElement(
            "div",
            null,
            showAudio
              ? source === "inline"
                ? createElement(ThreadInlineFilePreview, {
                    source: {
                      kind: "document",
                      name: "sound.mp3",
                      uri: "https://example.com/sound.mp3",
                    },
                    onOpen() {},
                  })
                : createElement(AudioFilePreview, {
                    uri: "https://example.com/sound.mp3",
                    onRetry() {},
                  })
              : null,
            createElement(MediaVideoPlayer, {
              uri: "https://example.com/clip.mp4",
              name: "clip.mp4",
              thumbnailKey: "clip",
              expanded: true,
              autoPlay: playVideo,
            }),
          ),
        );
      await act(async () => render());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find(
            (button) =>
              button.getAttribute("aria-label") === "Play audio" || button.textContent === "Play",
          )!
          .click(),
      );
      expect(audio.played).toHaveBeenCalledOnce();
      let sessionActive = true;
      const deactivated = vi.fn();
      // Match expo-audio iOS: the queued callback checks ownership at execution time.
      const queueDeactivation = () =>
        setTimeout(() => {
          if (audio.sessionOwned) return;
          sessionActive = false;
          audio.video.playing = false;
          deactivated();
        }, 100);
      audio.setSessionOwner.mockImplementation((owned) => {
        audio.sessionOwned = owned;
        if (!owned) queueDeactivation();
      });
      audio.player.pause.mockImplementation((deactivateSession) => {
        if (deactivateSession !== false) queueDeactivation();
      });
      vi.useFakeTimers();
      let recording: ReturnType<typeof acquireAudioSession> | undefined;
      try {
        if (release === "pause") {
          await act(async () =>
            [...container.querySelectorAll("button")]
              .find(
                (button) =>
                  button.getAttribute("aria-label") === "Pause audio" ||
                  button.textContent === "Pause",
              )!
              .click(),
          );
        } else if (release === "finish") {
          // Native completion queues deactivation before JS receives didJustFinish.
          queueDeactivation();
          audio.status = { ...audio.status, playing: false, didJustFinish: true };
          await act(async () => render());
        }
        if (release !== "takeover") {
          expect(vi.getTimerCount()).toBeGreaterThan(0);
          await vi.advanceTimersByTimeAsync(50);
        }
        await act(async () => {
          if (successor === "recording") {
            recording = acquireAudioSession("recording");
            await activateAudioSession(recording);
          } else if (successor === "native video controls") audio.video.play();
          else render(true);
        });
        if (successor !== "recording") expect(audio.video.playing).toBe(true);
        expect(audio.player.pause).toHaveBeenCalled();
        // Cleanup of the old native ref must not interrupt the successor either.
        await act(async () => render(successor === "video", false));
        await vi.advanceTimersByTimeAsync(200);
        expect(sessionActive).toBe(true);
        expect(deactivated).not.toHaveBeenCalled();
        expect(audio.setActive).not.toHaveBeenCalledWith(false);
        if (successor !== "recording") expect(audio.video.playing).toBe(true);
        else
          expect(audio.setAudioMode).toHaveBeenLastCalledWith(
            expect.objectContaining({ allowsRecording: true }),
          );
        await act(async () => root!.unmount());
        root = undefined;
        if (recording) await releaseAudioSession(recording);
        recording = undefined;
        await vi.advanceTimersByTimeAsync(200);
        expect(sessionActive).toBe(false);
      } finally {
        if (recording) await releaseAudioSession(recording);
        vi.clearAllTimers();
        vi.useRealTimers();
        audio.player.pause.mockReset();
      }
    },
  );

  it.each(["inline", "viewer"])("stops video before starting %s audio", async (source) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    audio.status = { ...audio.status, isLoaded: true };
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(
          "div",
          null,
          createElement(MediaVideoPlayer, {
            uri: "https://example.com/clip.mp4",
            name: "clip.mp4",
            thumbnailKey: "clip",
            expanded: true,
            autoPlay: true,
          }),
          source === "inline"
            ? createElement(ThreadInlineFilePreview, {
                source: {
                  kind: "document",
                  name: "sound.mp3",
                  uri: "https://example.com/sound.mp3",
                },
                onOpen() {},
              })
            : createElement(AudioFilePreview, {
                uri: "https://example.com/sound.mp3",
                onRetry() {},
              }),
        ),
      ),
    );
    expect(audio.video.playing).toBe(true);
    audio.video.pause.mockClear();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find(
          (button) =>
            button.getAttribute("aria-label") === "Play audio" || button.textContent === "Play",
        )!
        .click(),
    );
    expect(audio.video.playing).toBe(false);
    expect(audio.video.pause.mock.invocationCallOrder[0]).toBeLessThan(
      audio.player.play.mock.invocationCallOrder[0]!,
    );
    expect(audio.played).toHaveBeenCalledOnce();
    expect(audio.setActive).toHaveBeenLastCalledWith(true);
  });
});
