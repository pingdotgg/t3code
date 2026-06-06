# Voice Input Plugin Feature Spec

Status: draft

## Summary

T3 Code should support a trusted local plugin that records a short voice message from the
Composer, transcribes it to text, and inserts the transcript into the active Composer draft. The
first version is a record-then-transcribe flow, not realtime streaming. It should use Local Whisper
through `faster-whisper` as the recommended default, with plugin-owned settings and no automatic
dependency installation.

This feature intentionally improves the generic plugin host. The Composer should not know about a
hardcoded voice plugin. Instead, the host should expose Composer plugin placements, keybinding
metadata, and a small Composer insertion/interlock API that future Composer tools can reuse.

## Goals

- Add a microphone action in the Composer through a generic plugin UI placement.
- Let users click the mic button to start recording, then click again to stop and transcribe.
- Let users assign a keybinding through the existing Keybindings settings.
- Insert the completed transcript at the current Composer cursor or selection.
- Never auto-send transcribed text.
- Run transcription on the connected T3 backend, not in the browser.
- Keep recorded audio ephemeral by default.
- Provide a plugin Settings page for Local Whisper setup, model download, status checks, and test
  transcription.

## Non-Goals

- Realtime streaming transcription.
- Silence detection or auto-stop based on audio level.
- Audio level meter while recording.
- Audio file upload or drag/drop transcription.
- Text-to-speech.
- LLM transcript cleanup or rewriting.
- Automatic cloud fallback.
- Automatic installation of system or Python dependencies.
- Native mobile recording support.
- Persisting raw audio recordings.

## User Experience

### Composer Action

When the plugin is enabled, it contributes a mic action to a new Composer plugin placement. The mic
button has these states:

- `idle`: click starts recording.
- `recording`: active visual state with elapsed timer; click stops and starts transcription.
- `transcribing`: disabled/spinner state until transcription completes.
- `dependencyMissing`: disabled, with a tooltip pointing to plugin Settings.
- `permissionDenied`: disabled/error state, with a tooltip explaining browser microphone access.

If the plugin is disabled, failed, or not installed, no mic button is rendered.

### Recording Flow

1. User clicks the mic button or triggers `voiceInput.toggleRecording`.
2. Browser requests microphone access with `navigator.mediaDevices.getUserMedia`.
3. Browser records with `MediaRecorder`, preferring `audio/webm;codecs=opus` when available.
4. User clicks the mic button or triggers the keybinding again to stop.
5. Browser sends the completed audio blob to a plugin server command as base64.
6. Server writes a temporary audio file, transcribes it, deletes temporary files, and returns text.
7. Browser inserts the transcript into the Composer and focuses the editor.

`Escape` cancels an active recording and discards audio. For MVP, `Escape` does not cancel an
already-running server transcription request; late results should be ignored if the originating
Composer is no longer active.

### Composer Insertion

Transcripts are inserted immediately, never previewed.

Insertion rules:

- If the Composer has a selection, replace the selection.
- If the Composer has a known cursor, insert at the cursor.
- If the Composer is unfocused or cursor state is unknown, append at the end.
- If inserted text touches existing non-whitespace text, add a single whitespace boundary.
- Preserve normal send behavior after insertion so the user can edit before sending.

### Send Interlock

The Send button should not know about the voice plugin. Instead, the Composer should aggregate a
generic plugin action state:

```ts
type ComposerPluginActionState = {
  readonly blocksSend: boolean;
  readonly label?: string;
  readonly blockingReason?: string;
};
```

The voice plugin sets `blocksSend: true` while recording and transcribing. The existing primary
action logic consumes only the aggregate Composer busy/interlock state plus an optional
user-facing blocking reason for tooltip and accessibility copy. Example reasons:

- `Voice recording in progress`
- `Voice transcription in progress`

### Navigation And Reload

In-flight state is not persistent.

- Route or thread change while recording cancels recording and discards audio.
- Route or thread change while transcribing ignores the eventual result.
- Page reload loses recording/transcription state.
- Plugin settings persist.

## Host Extension Points

### Composer UI Contribution

Add a new plugin manifest contribution type for inline Composer actions. Do not overload existing
route-oriented `ui.placements`, because those entries open plugin routes from the sidebar, settings
sidebar, or command palette. A Composer mic button is inline interactive UI, not navigation.

Suggested manifest shape:

```json
{
  "ui": {
    "placements": [],
    "composerActions": [
      {
        "id": "voice-input",
        "label": "Voice input",
        "position": "composer.footer.left",
        "order": 100
      }
    ]
  }
}
```

Initial position:

- `composer.footer.left`: compact icon-sized actions near the existing model/runtime controls.

The host should pass a Composer-scoped UI context to registered Composer action renderers.

### Composer API

Expose a minimal browser-side Composer API to plugin action components:

```ts
interface PluginComposerApi {
  readonly composerId: string;
  readonly insertText: (text: string) => boolean;
  readonly focus: () => void;
  readonly readSnapshot: () => {
    readonly value: string;
    readonly cursor: number;
    readonly expandedCursor: number;
  };
  readonly setActionState: (state: ComposerPluginActionState) => void;
}
```

The concrete implementation should adapt to the existing `ChatComposerHandle` and Lexical editor
state rather than mutating DOM text.

### Plugin Keybinding Commands

Extend keybindings so active plugins can contribute client-target command metadata. The MVP
commands are:

- `plugin.t3.voice-input.toggleRecording`
- `plugin.t3.voice-input.cancelRecording`

Plugin keybinding commands should be namespaced by plugin id:

```ts
type PluginKeybindingCommand = `plugin.${PluginId}.${PluginCommandName}`;
```

The schema should be equivalent to:

```ts
Schema.TemplateLiteral(["plugin.", PluginId, ".", PluginCommandName]);
```

This keeps built-in commands, project script commands, and plugin commands distinct while preventing
collisions between plugins.

The default shortcut is empty. Users assign shortcuts in the existing Keybindings settings. Plugin
settings may show the current shortcut and link to Keybindings, but keybindings should remain in the
existing keybinding store so conflict detection stays centralized. Server-target plugin RPC commands
must not be surfaced as keybinding commands.

## Plugin Package Shape

Suggested package:

```text
packages/plugins/voice-input/
  package.json
  vite.client.config.ts
  src/
    manifest.json
    shared/
      constants.ts
      schema.ts
    client/
      index.tsx
      VoiceInputComposerAction.tsx
      VoiceInputSettingsPage.tsx
      useVoiceRecorder.ts
    server/
      index.ts
      plugin.ts
      commands.ts
      localWhisper.ts
      dependencies.ts
      tempAudio.ts
      modelCache.ts
    server.test.ts
```

The plugin should import host APIs only through `@t3tools/plugin-api` subpaths. If additional host
surface is needed, extend `packages/plugin-api` first.

The server plugin API should expose plugin-scoped filesystem paths through the activation context:

```ts
interface PluginActivationPaths {
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly tempDir: string;
}
```

The voice plugin should use:

- `ctx.paths.cacheDir/models/whisper` for downloaded Whisper models.
- `ctx.paths.tempDir/audio` for temporary recording and conversion files.
- Plugin document storage for settings and durable feature data.

The plugin should not derive `$T3CODE_HOME/plugins-data/...` paths by convention in plugin code.

## Settings

The plugin contributes a Settings route through the existing plugin settings surface.

Recommended fields:

- Enabled: boolean.
- Provider: `localWhisper` for MVP.
- Whisper model: `tiny`, `base`, `small`, `medium`, `large-v3`; default `base`.
- Language: `auto` by default.
- Device: `auto`, `cpu`, `cuda`.
- Max recording seconds: default `120`.
- Max upload bytes: default `25 MB`.
- Transcription timeout seconds: default `120`, maximum `600`.
- Prompt hint: optional textarea, default empty.
- Cache path: read-only display from the host-provided plugin cache directory.

Status checks:

- Browser microphone permission state when available.
- Backend dependency status:
  - Python/runtime available.
  - `faster-whisper` importable.
  - selected model cached.
  - `ffmpeg` available, optional unless a selected backend requires conversion.

Actions:

- Download selected model with progress.
- Test Local Whisper with a tiny bundled/generated sample or model-load smoke test.

No system dependency should be installed automatically. Settings can show exact install commands.

Important UX copy:

> Microphone recording happens in this browser. Local Whisper runs on the connected T3 backend.

## Transcription Backends

### Local Whisper

MVP default backend.

- Use Python `faster-whisper`.
- Model cache lives in the host-provided plugin cache directory.
- Default model is `base`.
- Default language is auto-detect.
- Optional prompt hint is passed through when supported.
- `ffmpeg` is not required by default if the backend can decode the browser recording format.

The server can call a small Python helper script to keep model loading and transcription isolated
from TypeScript process logic. The TypeScript command handler owns validation, temporary files,
timeouts, and result parsing.

Timeout policy:

- Browser recording max: `120s`.
- Transcription command default timeout: `120s`.
- Transcription command maximum configurable timeout: `10m`.
- Model download timeout: `30m`, code constant only for MVP.

If transcription times out, delete temporary files and leave Composer text untouched. If model
download times out, report failure, refresh model status, and rely on the underlying Hugging
Face/faster-whisper cache behavior for partial cache cleanup or reuse.

Model download should be a long-running plugin command that publishes progress through plugin
events. Suggested event names:

- `voiceInput.modelDownload.started`
- `voiceInput.modelDownload.progress`
- `voiceInput.modelDownload.completed`
- `voiceInput.modelDownload.failed`

The Settings page starts the command, subscribes to plugin events, and renders progress/status. The
command can still return final success or failure, but the UI should not rely on a silent long
request for large model downloads.

### Local Command

This is useful as a future escape hatch after Local Whisper proves the end-to-end Composer loop.

The plugin writes input audio to `{input_path}`, creates `{output_dir}`, runs a configured command,
and reads a transcript file such as `{output_dir}/transcript.txt`. This mirrors Hermes-style custom
STT and lets advanced users wire `whisper.cpp`, a local ASR server, NVIDIA Nemotron ASR, Groq CLI,
or other tools without hardcoding them into T3.

### Cloud Providers

OpenAI/Groq or similar cloud STT providers are not required for the first Local Whisper slice. If
added later, selection must be explicit and there must be no automatic fallback from local to cloud.

## Audio Handling

Browser:

- Use `getUserMedia` and `MediaRecorder`.
- Prefer `audio/webm;codecs=opus`.
- Keep audio in memory only until upload.
- Enforce max duration and max size before sending.

Transport:

- Use existing plugin RPC with base64 audio for MVP.
- Add binary upload/streaming transport only when needed for longer recordings or realtime STT.

Server:

- Decode base64 into a temporary plugin-owned work directory.
- Run transcription with timeout and bounded output parsing.
- Delete input and intermediate files after success or failure.
- Return only transcript text and lightweight metadata.
- Do not persist raw audio by default.

## Privacy And Safety

- No audio persistence by default.
- No cloud fallback.
- No automatic dependency installation.
- No auto-send after transcription.
- Browser permission denial is surfaced clearly.
- Remote backend behavior is explicit in Settings.
- Transcription failures leave Composer text untouched.
- Logs should not include raw audio or full transcript unless needed at debug level and explicitly
  reviewed.

## Test Plan

Contracts and shared logic:

- Plugin manifest accepts Composer/action placement contributions.
- Plugin keybinding command schema accepts active client-target plugin commands without accepting
  arbitrary invalid commands or server RPC commands.
- Composer insertion helper handles empty text, cursor insertion, selection replacement, append
  fallback, and whitespace boundaries.

Web:

- Mic action renders only when plugin is active.
- Recording state toggles correctly.
- `Escape` cancels recording.
- Send is blocked only via generic Composer action interlock.
- Send blocking exposes a generic user-facing reason without coupling the Send button to the voice
  plugin.
- Transcription result inserts at cursor and does not auto-send.
- Route/thread change cancels or ignores in-flight voice state.
- Permission denial shows a stable error state.

Server:

- Dependency detection reports missing Python, missing `faster-whisper`, missing model, and optional
  `ffmpeg`.
- Model download uses the host-provided plugin cache path.
- Model download publishes progress events and final status.
- Transcription command writes temp files, deletes them on success/failure, validates size limits,
  and handles backend errors.
- Transcription and model download enforce the documented timeouts.
- Test transcription command exercises model load or a tiny sample.

End-to-end:

- With Local Whisper `base` cached, record a short voice message and insert transcript into the
  Composer.
- With existing Composer text, recording blocks send until insertion completes.
- With a remote environment, settings and backend status reflect the remote backend.

Required checks before completion:

- `vp check`
- `vp run typecheck`

## Future Work

- Realtime streaming transcription.
- Silence auto-stop with configurable threshold.
- Audio level meter.
- Optional `whisper.cpp` backend.
- Optional `localCommand` backend.
- Optional NVIDIA Nemotron ASR via local command or NIM endpoint.
- Explicit cloud STT providers.
- Opt-in transcript cleanup with strict preview.
- Binary upload or streaming transport for plugin media.
- Clear downloaded model action.
- More detailed model performance guidance by device.

## Open Questions

None for the MVP feature spec. New questions should be added here as implementation discovers
unknowns.
