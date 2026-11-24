import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  prepareEnvironmentSpeech,
  speakEnvironmentText,
} from "@t3tools/client-runtime/voice-input";
import {
  VOICE_OFF,
  type EnvironmentId,
  type RunId,
  type ScopedThreadRef,
  type VoiceMode,
  type VoiceState,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { environmentSummaries } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { readPreparedConnection } from "../state/session";
import { environmentThreadDetails } from "../state/threads";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { toSpeakableSentences } from "./speakable";
import { latestReply } from "./voiceReplies.logic";

export type ActiveVoiceMode = Exclude<VoiceMode, "off">;

/** The thread that has voice: the newest voice turned on in any environment. */
export const voiceThreadAtom = Atom.make(
  (get): (ScopedThreadRef & { mode: ActiveVoiceMode; setAt: string }) | null => {
    let owner: (ScopedThreadRef & { mode: ActiveVoiceMode; setAt: string }) | null = null;
    for (const environmentId of get(environmentSummaries.environmentIdsAtom)) {
      const voice = get(serverEnvironment.configValueAtom(environmentId))?.settings.voice;
      if (voice === undefined || voice.mode === "off" || voice.threadId === null) continue;
      if (owner === null || voice.setAt > owner.setAt)
        owner = { environmentId, threadId: voice.threadId, mode: voice.mode, setAt: voice.setAt };
    }
    return owner;
  },
).pipe(Atom.withLabel("web-voice-thread"));

/** Whether a reply is being read aloud, so two-way voice stops listening meanwhile. */
export const voiceSpeakingAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-voice-speaking"),
);

/**
 * Gives voice in `mode` to `thread`, or turns it off everywhere for `null`; resolves whether it
 * saved and reports a failure.
 */
export async function setVoiceThread(
  registry: AtomRegistry.AtomRegistry,
  thread: ScopedThreadRef | null,
  mode: ActiveVoiceMode = "oneWay",
): Promise<boolean> {
  const setAt = new Date().toISOString();
  const results = await Promise.all(
    registry.get(environmentSummaries.environmentIdsAtom).map((environmentId) => {
      const current = registry.get(serverEnvironment.configValueAtom(environmentId))?.settings
        .voice;
      const voice: VoiceState | null =
        thread?.environmentId === environmentId
          ? { mode, threadId: thread.threadId, setAt }
          : current !== undefined && current.mode !== "off"
            ? VOICE_OFF
            : null;
      if (voice === null) return undefined;
      return runAtomCommand(
        registry,
        serverEnvironment.updateSettings,
        { environmentId, input: { patch: { voice } } },
        { label: "voice mode update" },
      );
    }),
  );
  const saved = results.every((result) => result === undefined || result._tag === "Success");
  if (!saved) toastManager.add({ type: "error", title: m(msg("Voice mode could not be saved")) });
  return saved;
}

/** Sets `thread`'s voice to `mode`; resolves whether it saved. */
export function changeVoiceMode(
  registry: AtomRegistry.AtomRegistry,
  thread: ScopedThreadRef,
  mode: VoiceMode,
): Promise<boolean> {
  return mode === "off" ? setVoiceThread(registry, null) : setVoiceThread(registry, thread, mode);
}

/** `thread`'s voice mode. */
export function threadVoiceMode(
  voiceThread: { threadId: string; mode: ActiveVoiceMode } | null,
  thread: ScopedThreadRef,
): VoiceMode {
  return voiceThread?.threadId === thread.threadId ? voiceThread.mode : "off";
}

function reportVoiceFailure(error: unknown) {
  toastManager.add({
    type: "error",
    title: m(msg("Voice replies failed")),
    description: error instanceof Error ? error.message : String(error),
  });
}

function speak(environmentId: EnvironmentId, text: string): Promise<Uint8Array> {
  const prepared = readPreparedConnection(environmentId);
  if (prepared === null) return Promise.reject(new Error("The environment is not connected."));
  return runEnvironmentSpeech(speakEnvironmentText(prepared, text));
}

function play(wav: Uint8Array, signal: AbortSignal): Promise<void> {
  const url = URL.createObjectURL(
    new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
  );
  const audio = new Audio(url);
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      signal.removeEventListener("abort", stop);
      audio.pause();
      URL.revokeObjectURL(url);
      if (error === undefined) resolve();
      else reject(error);
    };
    const stop = () => finish();
    signal.addEventListener("abort", stop);
    audio.addEventListener("ended", () => finish());
    audio.addEventListener("error", () => finish(new Error("The reply audio could not play.")));
    audio.play().catch(finish);
  });
}

/** Reads one sentence while the next is synthesized. */
async function readAloud(environmentId: EnvironmentId, text: string, signal: AbortSignal) {
  const sentences = toSpeakableSentences(text);
  let next = sentences.length > 0 ? speak(environmentId, sentences[0]!) : null;
  for (let index = 0; next !== null; index += 1) {
    const wav = await next;
    if (signal.aborted) return;
    const following = sentences[index + 1];
    next = following === undefined ? null : speak(environmentId, following);
    // A stop leaves the prefetched sentence unread.
    next?.catch(() => undefined);
    await play(wav, signal);
    if (signal.aborted) return;
  }
}

/**
 * Reads the voice thread's replies aloud as its runs complete. Replies that finished before
 * this window started following the thread stay silent.
 */
export function startVoiceReplies(registry: AtomRegistry.AtomRegistry): () => void {
  let session: { key: string; stop: () => void } | null = null;

  const follow = (thread: ScopedThreadRef) => {
    const controller = new AbortController();
    const followedAtMs = Date.now();
    let lastRunId: RunId | null = null;
    let queue = Promise.resolve();
    const prepared = readPreparedConnection(thread.environmentId);
    if (prepared !== null)
      runEnvironmentSpeech(prepareEnvironmentSpeech(prepared)).catch(reportVoiceFailure);
    const unsubscribe = registry.subscribe(
      environmentThreadDetails.threadAtom(thread),
      (detail) => {
        if (detail === null) return;
        const reply = latestReply(detail.projection);
        if (reply === null || reply.runId === lastRunId || reply.completedAtMs < followedAtMs)
          return;
        lastRunId = reply.runId;
        queue = queue
          .then(async () => {
            if (controller.signal.aborted) return;
            registry.set(voiceSpeakingAtom, true);
            try {
              await readAloud(thread.environmentId, reply.text, controller.signal);
            } finally {
              registry.set(voiceSpeakingAtom, false);
            }
          })
          .catch(reportVoiceFailure);
      },
      { immediate: true },
    );
    return () => {
      controller.abort();
      unsubscribe();
    };
  };

  const sync = (thread: ScopedThreadRef | null) => {
    const key = thread === null ? null : `${thread.environmentId}\u0000${thread.threadId}`;
    if (session?.key === key) return;
    session?.stop();
    session = thread === null || key === null ? null : { key, stop: follow(thread) };
  };
  const unsubscribe = registry.subscribe(voiceThreadAtom, sync, { immediate: true });
  return () => {
    unsubscribe();
    sync(null);
  };
}
