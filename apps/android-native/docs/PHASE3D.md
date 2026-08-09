# Phase 3D — Review

## Goal

Let a user inspect turn, working-tree, and base-branch changes and send line-specific feedback without leaving the native Android thread.

## Capability matrix

| Journey                  | Server contract                                 | Android behavior                                                                  |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Discover review sections | Thread checkpoints and `review.getDiffPreview`  | Shows ready turns newest-first, then working-tree and base-branch sections        |
| Load a turn diff         | `orchestration.getTurnDiff`                     | Requests the selected checkpoint range and replaces it when refreshed             |
| Navigate files           | Diff preview/turn patch                         | Uses a file navigator and virtualized flattened Canvas rows                       |
| Expand or collapse       | Local review state                              | Persists independently for each environment, thread, and section                  |
| Mark viewed              | Local review state                              | Marks the file viewed and collapses it, matching the RN interaction               |
| Handle exceptional files | Patch metadata and bounded rows                 | Shows non-text, large-diff, raw-patch, empty, and truncation notices              |
| Add contextual feedback  | Existing thread composer draft                  | Encodes the selected line range as a `<review_comment>` block and returns to chat |
| Send feedback            | Existing `thread.turn.start` and durable outbox | Sends review blocks with any plain draft text through the normal chat path        |
| Render sent feedback     | Existing thread message stream                  | Presents review blocks as comment cards rather than raw markup                    |
| Refresh                  | Same selected-section RPC                       | Fetches the selected turn or Git section again; live checkpoints update the menu  |

The server remains authoritative for checkpoints and Git diff sources. A route change cancels stale requests, and a late response is applied only to the matching environment/thread target.

## Shared renderer

The RN Android review view is split into a plain `ReviewDiffSurfaceView` and a thin Expo adapter. Native Android's `:review-renderer` module compiles that same Canvas renderer directly from the RN module, while Compose hosts it through `AndroidView`.

Rows are flattened before crossing into the renderer. The Canvas surface draws only the visible range and owns scrolling, sticky file headers, horizontal pan, selection, collapse, viewed, and comment-card interaction. Compose owns section/file controls, server state, and the comment dialog.

## Review comment format

Selecting one or more lines and adding a comment appends a self-contained `<review_comment>` block to the existing thread draft. The block records the section, file, zero-based row range, human-readable line range, and a fenced unified-diff excerpt. Attribute values are escaped, and a fence longer than any fence in the selected source is used.

The same parser drives comment cards in the composer and sent user messages. Editing plain draft text preserves embedded review blocks; removing a card deletes only that block. Existing outbox persistence and retry behavior therefore apply without a parallel review queue.

## Entry points

- Thread toolbar: Review
- Git overview: Review changes
- Thread composer and sent user messages: contextual review cards

## Verification

Focused local gate:

```bash
./gradlew :protocol:test \
  :app:testDebugUnitTest --tests com.t3tools.android.nativeapp.ReviewStateTest \
  :app:compileDebugAndroidTestKotlin :app:assembleDebug
```

Protocol tests cover exact preview, file-content, turn-diff, and checkpoint decoding. App tests cover standard unified patches, section ordering, contextual selection, escaping, formatting, and round-trip parsing. The on-device `ReviewDiffSurfaceViewTest` creates the shared renderer, decodes rows off the UI thread, lays it out, applies selection/collapse/viewed state, navigates, and destroys it.

Manual device acceptance covers all three section types, refresh, live checkpoint arrival, file navigation, collapse/viewed persistence, large/non-text/truncated states, single- and multi-line comments, draft preservation/removal, send/reconnect, and sent comment cards.

## Boundaries

Phase 3D does not add file editing, side-by-side diffs, syntax-token generation, attachments, camera/gallery/document pickers, or uploads. T3 Connect administrator approval is not a gate. Performance measurement remains deferred until Phase 3E is complete.
