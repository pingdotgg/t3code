# Pocket TTS migration

Jarvis speech output runs PocketTTS.cpp with ONNX Runtime behind the existing
native speech boundary. One voice lifecycle serves Full and Controller;
Headless and disabled clients stay idle and never spawn the worker.

## Pinned configuration

- Runtime: PocketTTS.cpp `e801e7d6c2692121a39e80ae525cb5265174a495` plus the
  production edits in `packages/jarvis-native-voice/native/pocket` (mixed
  precision split, three-frame chunks, no disk cache, no legacy space padding,
  BOS voice bias in code, bounded 16-entry stream queue, typed stream errors,
  fixed inference budget).
- Models: stephvax `pocket-tts-onnx` `fc68ee7e5a0a29662e218df84b24acb311f7fb6d`,
  bundle `english_2026-04`, mixed precision (INT8 language model, FP32 flow
  network and Mimi decoder).
- Inference: temperature 0.3, one flow step, two CPU threads, first chunk one
  frame, later chunks capped at three frames, 50-token bundle bound, 24 kHz.
- Voice: Kyutai `alba-mackenna/casual.wav`, first three seconds, mono 24 kHz
  (`voices/alba-casual-3s.wav`, CC BY 4.0, Alba MacKenna).
- Onset filter: -50 dBFS, 10 ms RMS window, 40 ms preroll, 2 s maximum removal.
  Only the leading prefix is removed; quiet attacks survive and every later
  pause is preserved.
- ONNX Runtime 1.23.2, SentencePiece v0.2.1.

Pins live in `native/pocket/PINNED_REVISIONS.json`. The build script applies
each production edit as an exact-match replacement and fails loudly on drift.

## Process layout

Parent (desktop voice worker or Companion) forks `pocket-worker.cjs`. That
Node child owns one `jarvis-pocket-tts` daemon process: model load and warmup
once, one active synthesis at a time, chunk WAV files per request, process
exit on close. Overlapping synthesis is rejected, never queued into the model.

Cancellation kills the worker process (SIGTERM, then SIGKILL after two
seconds), which wakes the blocked native read, stops generation, discards
queued playback, and joins before the lifecycle permits reuse. Disable,
shutdown, failure, and model release all take the same path, so decoder state
and the in-memory voice entry cannot leak across generations.

Native failures arrive as typed `failed` events with the daemon's message.
An empty filtered result still completes normally; it is never upgraded into
a failure and never presented as successful speech.

## Text handling

The daemon splits sentences with the C++ splitter, prepares each sentence
(capitalization, terminal punctuation, short-sentence EOS frames), and resets
decoder state per sentence. Long input is bounded by the 50-token bundle
limit and the 500-frame per-request cap; tmp audio per request stays under
about 8 MiB and is removed after synthesis.

## Packaging

`prepare:voice` runs `ensure-parakeet-resources.mjs` and
`ensure-pocket-resources.mjs`. The Pocket script downloads the pinned ONNX
files with SHA-256 checks, derives the Alba reference and the raw voice-bias
vector, stages the reproducibly built daemon and ONNX Runtime libraries, and
writes `PROVENANCE.json`. Nothing is downloaded at runtime and no checkout,
`/tmp`, or Python paths ship. Pocket resources live beside the retired Kokoro
directory, so upgrades work without manual cache deletion.

Desktop and Companion stage `jarvis-resources/pocket` and the
`pocket-worker.cjs` bundle. Per-platform CI asserts the daemon, the ONNX
library, the model set, the voice reference, and provenance.

## Verification

Unit tests cover streaming order, bounded queues, cancellation before first
output and mid-stream, error propagation, repeated reuse, disable/re-enable,
cleanup, short utterances, quiet starts, negations, numbers, long sentences,
and sentence endings. `benchmark-pocket.mjs` measures the production
adapter's audible latency, gaps, cancellation, and RSS. Targets: warm audible
under 350 ms, cancellation under 150 ms, peak RSS under 800 MiB, WER under 7%.
Release candidates still need the real-device acceptance pass: physical
speaker, microphone permission, hotkey, and each shipped OS/arch.
