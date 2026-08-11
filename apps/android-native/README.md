# T3 Code Native Android

Independent native Android client for T3 Code. The formal Phase 2–4A roadmap is complete, followed by product-parity passes across threads, composers, settings, usage, archives, appearance, project grouping, environment management, and adaptive large-screen navigation.

## Modules

- `:protocol` — pairing, bearer authentication, Effect RPC WebSocket transport, typed shell/thread/workspace/Git/terminal/review/attachment models, sequence-aware reducers, commands, and the headless proof harness.
- `:terminal-renderer` — the shared Ghostty VT/JNI and Canvas renderer compiled from the RN terminal module's plain Android sources.
- `:review-renderer` — the shared virtualized Canvas diff renderer compiled from the RN review module's Expo-free Android surface.
- `:app` — Compose UI, multi-environment supervisors, SQLite catalog/outbox/cache, app-private attachment storage, project/files/Git/terminal/review UI, T3 Connect client, and Android Keystore-backed credentials.

The Kotlin implementation targets the current matching T3 server revision. Broader server-version compatibility is not promised until versioned wire artifacts exist.

## Current product surface

The native client supports direct and relay environments, durable offline drafts/outbox recovery, new and existing thread turns, thread organization and archived threads, project and branch/worktree selection, workspace files/search, Git operations, terminal sessions, review diffs/comments, image attachments, Android share intake, launcher shortcuts, usage reporting, client storage controls, typography settings, and project grouping.

The settings parity matrix lives in [`docs/SETTINGS_COMPARISON.md`](docs/SETTINGS_COMPARISON.md). The final validation record and known boundaries live in [`docs/RELEASE_READINESS.md`](docs/RELEASE_READINESS.md). T3 Connect is implemented through Clerk, DPoP, and the managed relay, but production OAuth remains externally gated until Clerk allowlists the native Android redirect.

## Adaptive workspace

The app uses compact navigation on phones. At an available window size of at least 720 dp wide and 600 dp high, it switches to a persistent thread sidebar sized to 32% of the window and clamped between 280 and 380 dp. The sidebar remains visible through thread, files, Git, terminal, and review screens. Settings, onboarding, and other account-level flows continue to use the full window.

The layout responds to the current window rather than device type, so the same behavior covers tablets, foldables, freeform windows, and Samsung DeX. Resizing preserves the selected thread and ViewModel-owned drafts.

## Wire protocol

The server uses one JSON-encoded Effect RPC envelope per WebSocket message. It is not JSON-RPC 2.0.

Client envelopes:

```text
Request   { _tag, id, tag, payload, headers }
Interrupt { _tag, requestId }
Ack       { _tag, requestId }
Ping      { _tag }
Eof       { _tag }
```

Server envelopes:

```text
Chunk               { _tag, requestId, values[] }
Exit success         { _tag, requestId, exit: { _tag: "Success", value } }
Exit failure         { _tag, requestId, exit: { _tag: "Failure", cause[] } }
Defect               { _tag, defect }
Pong                 { _tag }
ClientProtocolError  { _tag, error }
```

Requests are multiplexed by numeric id. Every received chunk is acknowledged. Cancelling a stream sends `Interrupt`. Unknown object members are tolerated; unknown envelope tags close the socket as a protocol error.

Golden fixtures live at `protocol/src/test/resources/effect-rpc.json`. They are encoded through the repository-pinned Effect serializer and T3 command schema:

```bash
pnpm fixtures
pnpm fixtures:check
```

## Authentication

Pairing performs these steps:

1. Parse a direct or hosted `/pair#token=…` URL.
2. Fetch `/.well-known/t3/environment`.
3. Exchange the one-time credential through form-encoded `POST /oauth/token`.
4. Persist only the scoped bearer credential.
5. Request a short-lived ticket from `POST /api/auth/websocket-ticket`.
6. Open `/ws?wsTicket=…` and call `server.getConfig`.
7. Reject the connection if the discovered and WebSocket environment ids differ within the same handshake.

On reconnect, the server descriptor is authoritative. A successfully authenticated server with a changed environment id replaces the saved credential key and environment-scoped cache. If the old bearer is rejected, pairing the same endpoint replaces its stale environment entry after the new handshake succeeds.

The Android store encrypts the serialized credential with AES-GCM and a non-exportable Android Keystore key. The environment id is authenticated as additional data.

## Verification

Focused JVM tests, app unit tests, and APK build:

```bash
./gradlew :protocol:test :app:testDebugUnitTest :app:assembleDebug
```

Persistence, onboarding, and credential restoration on a connected Android device:

```bash
./gradlew :app:connectedDebugAndroidTest
```

An opt-in device integration test also runs the protocol over Android's network stack. Route the disposable server port to the device and pass a fresh one-time pairing URL as the `pairingUrl` instrumentation argument; the test clears the saved bearer credential afterward.

The black-box harness reads its one-time pairing URL from the environment so it never enters source control or command output:

```bash
T3_NATIVE_PAIRING_URL='<fresh-url>' \
T3_NATIVE_PROMPT='Count slowly from one to twenty, one number per line.' \
./gradlew :protocol:run
```

It must exit 0 after pairing, loading the shell, creating one task with atomic `thread.turn.start`, recovering an uncertain retry by deterministic thread id, streaming assistant output, dispatching `thread.turn.interrupt`, reconnecting from the saved bearer credential, probing the server, and resuming shell/thread streams without duplicate sequences.

## Phase 4A system integration

Android can share text, one image, or multiple images into an app-private recovery inbox. The user then chooses an environment and continues through the existing new-task draft, including its project selection and attachment limits. The inbox survives process death and remains resumable from Home until accepted or explicitly discarded.

The launcher exposes a static New task shortcut and up to three dynamic recent-thread shortcuts. Only the documented `t3code-native` routes are accepted; arbitrary commands, paths, query parameters, and server URLs are rejected.

The Phase 4A capability matrix and S25 acceptance steps live in [`docs/PHASE4A.md`](docs/PHASE4A.md).

## Product boundaries

Gallery selection, explicit clipboard paste, attachment previews/removal, attachment-only messages, durable draft/outbox recovery, retry/edit/delete cleanup, and sent-image rendering are implemented. Images are capped at eight per message and 10 MB each. The server remains authoritative for sent attachment ids and signed asset URLs.

Camera capture, document/video attachments, direct sharing to an existing thread, and file editing remain intentional product boundaries. Production signing and store automation are not configured for this independent APK. T3 Connect administrator approval is an external deployment gate rather than missing client implementation. If performance work resumes, first reproduce the documented long-thread debug trace with a release build before changing feed behavior.

The Phase 3E capability matrix and device acceptance steps live in [`docs/PHASE3E.md`](docs/PHASE3E.md). Thread-feed parity and catch-up behavior live in [`docs/THREAD_FEED.md`](docs/THREAD_FEED.md). Earlier evidence remains in [`docs/PHASE3D.md`](docs/PHASE3D.md), [`docs/PHASE3C.md`](docs/PHASE3C.md), [`docs/PHASE3B.md`](docs/PHASE3B.md), [`docs/PHASE3A.md`](docs/PHASE3A.md), and [`docs/PHASE2.md`](docs/PHASE2.md).

### Atomic bootstrap retry caveat

The current server creates the bootstrap `thread.create` with a fresh server-generated command id before dispatching the client `thread.turn.start`. Resending the same client command after an uncertain response can therefore attempt to create the same thread twice before the outer receipt is consulted. The native client does not blindly resend: after reconnect it synchronizes the shell, treats the deterministic thread id as accepted when present, and resends the original command only when the thread is absent. This observed wire behavior is pinned by the Phase 0 real-server proof and should be revisited if the server makes bootstrap ids deterministic.
