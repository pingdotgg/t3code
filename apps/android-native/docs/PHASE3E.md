# Phase 3E — Image attachments

## Goal

Let a user attach existing images to a new task or thread message, recover that work after process death or disconnection, and view sent images without leaving the native Android client.

## Capability matrix

| Journey            | Server contract                                | Android behavior                                                                                                     |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Pick images        | `thread.turn.start` image uploads              | Uses Android Photo Picker with multi-selection                                                                       |
| Paste              | Same upload shape                              | Explicit paste accepts a clipboard image URI or falls back to clipboard text                                         |
| Compose            | Local draft                                    | Shows removable thumbnails and a larger tap preview; text is optional when images exist                              |
| Persist            | Local app storage                              | Copies images into environment-scoped app-private files and stores only metadata and paths                           |
| Queue              | Durable SQLite outbox                          | Persists attachment metadata with the stable command/message ids; upload data is materialized only at dispatch       |
| Retry and edit     | Existing outbox controls                       | Retains images across retry, permits text and image edits while not sending, and rejects an empty result             |
| Delete and send    | Reference-based cleanup                        | Removes files only after neither a draft nor pending task references them                                            |
| Render             | `assets.createUrl` with an attachment resource | Resolves the server-issued attachment id to a signed URL and shows a tappable sent-image preview                     |
| Restore            | Draft store plus SQLite migration              | Restores draft and pending thumbnails after process death; database v1 migrates to v2 with empty attachment metadata |
| Remove environment | Existing environment removal                   | Removes its drafts, outbox rows, credentials, cache, and environment-scoped attachment files                         |

The server is the source of truth after a message is accepted. The client never invents a sent attachment id and never persists a base64/data URL in SQLite or preferences.

## Limits and ownership

- Images only.
- At most eight images per message.
- At most 10 MB per image.
- Picker content is copied immediately; later access does not depend on a temporary provider permission.
- Paths are accepted only below the app-owned attachment root.
- Failed or partial copies remove their temporary files.
- Draft and outbox references are reconciled before unreferenced files are deleted.

## Verification

Focused local gate:

```bash
./gradlew \
  :protocol:test --tests com.t3tools.android.protocol.ChatCommandsTest \
  --tests com.t3tools.android.protocol.ChatReducersTest \
  :app:testDebugUnitTest --tests com.t3tools.android.nativeapp.AttachmentStoreTest \
  :app:compileDebugAndroidTestKotlin \
  :app:assembleDebug
```

Protocol tests cover attachment-only commands, deferred upload materialization, and reducer preservation across message updates. App JVM tests cover exact-limit copies plus empty/oversize cleanup. Android database tests cover attachment outbox round-tripping and the v1-to-v2 migration; they are compiled locally and run only on an emulator or disposable test device.

## S25 manual acceptance

Installing the debug APK uses `adb install -r` only. Do not run `connectedDebugAndroidTest` on the physical phone because instrumentation clears app data.

1. In a new task, pick several images, preview one, remove one, enter optional text, and create the task.
2. In an existing thread, paste a clipboard image, send an attachment-only message, and confirm the sent image opens in the larger preview.
3. Leave a draft with images, force-stop the app, reopen it, and confirm its text and thumbnails remain.
4. Queue a message while disconnected, force-stop/reopen, then reconnect and confirm one send with no duplicate.
5. Edit a failed pending task, add/remove an image, retry it, and confirm the remaining image is sent.
6. Delete a pending task and remove a draft image; reopen the app and confirm neither returns.
7. Attempt a ninth image, a non-image URI, and an image above 10 MB; confirm each is rejected without losing accepted images.

## Boundaries

Phase 3E does not add camera capture, document/video attachments, Android share-target intake, file editing, or performance benchmarking. T3 Connect administrator approval is not a Phase 3E gate. Performance testing begins after Phase 3 is accepted.
