# Phase 4A — Android system integration

## Goal

Make the native client useful from Android's share sheet and launcher while keeping all incoming data recoverable and all external navigation narrowly scoped.

## Capability matrix

| Entry                  | Android input                          | Native behavior                                                                                                   |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Share text             | `ACTION_SEND` + `text/plain`           | Copies the text into a private pending-share record, then appends it to the selected environment's new-task draft |
| Share one image        | `ACTION_SEND` + `image/*`              | Copies the provider URI immediately into private storage and continues through the existing image-draft path      |
| Share images           | `ACTION_SEND_MULTIPLE` + `image/*`     | Copies up to eight images, reports skipped or invalid items, and preserves accepted items                         |
| Recover share          | Process death or interrupted selection | Shows the newest pending share on Home until the user resumes or discards it                                      |
| New task shortcut      | Static launcher shortcut               | Opens the existing new-task screen, or onboarding when no environment is saved                                    |
| Recent thread shortcut | Up to three dynamic shortcuts          | Selects the shortcut's saved environment and opens the thread; removed environments also remove their shortcuts   |
| App route              | `t3code-native://…`                    | Accepts only Add environment, New task, and environment-scoped Thread routes                                      |

The server remains the source of truth for environments, projects, threads, and sent attachments. Phase 4A adds no server commands and does not embed bearer credentials, server URLs, task text, or image contents in launcher routes.

## Ownership and recovery

- Shared image URIs are consumed immediately; later recovery never depends on the source app retaining a URI grant.
- Pending-share metadata is committed only after accepted images have been copied into the app-private inbox.
- Accepting a share first saves the ordinary new-task draft, then removes the inbox copy.
- Back navigation leaves pending content intact. Discard is the explicit deletion path.
- Existing draft text is preserved; shared text is appended with a blank-line separator.
- Existing eight-image and 10 MB-per-image limits remain authoritative.

## Route allowlist

Accepted routes:

```text
t3code-native://connections/new
t3code-native://new
t3code-native://threads/<environment-id>/<thread-id>
```

Routes with a different scheme, unknown host/path, extra segment, user info, port, query, or fragment are ignored. Thread shortcuts carry both environment and thread identity so multi-environment navigation is deterministic.

## Verification

Focused local gate:

```bash
./gradlew \
  :app:testDebugUnitTest \
    --tests com.t3tools.android.nativeapp.SystemRoutesTest \
    --tests com.t3tools.android.nativeapp.LauncherShortcutsTest \
  :app:assembleDebug
```

The JVM tests pin the route allowlist, supported share shapes, draft-text merge behavior, recent ordering, deduplication, and the three-thread cap.

## S25 manual acceptance

Install with `adb install -r`; do not run instrumentation on the physical phone.

1. With the app killed, share text from another app. Choose an environment and project, then confirm the new-task composer contains the text.
2. Repeat while the app is warm and confirm the same intake screen appears once.
3. Share one image and then several images. Confirm their names appear during intake and their previews appear in the new-task composer.
4. Start a share, leave with Back, kill and reopen the app, and resume it from the Home card.
5. Long-press the launcher icon. Open New task, then open each recent-thread shortcut and confirm it selects the correct environment.
6. Open each documented app route through ADB. Confirm malformed and unknown routes do nothing.
7. Remove an environment and confirm its recent-thread shortcuts disappear.

## Boundaries

Phase 4A does not add documents, video, camera capture, direct share-to-existing-thread, arbitrary URL handling, notification actions, widgets, or new server APIs. System sharing enters the recoverable new-task workflow; the user remains responsible for choosing the project and sending the task.
