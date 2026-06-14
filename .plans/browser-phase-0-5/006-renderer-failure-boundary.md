# ADR 006: Renderer Failure Boundary

## Status

Accepted, revising ADR 001 terminology and failure handling.

## Decision

Keep the renderer-hosted Electron `<webview>` for the next implementation iteration because it supports normal renderer composition, annotations, and the selected covered-surface recording strategy.

Do not describe this as process-durable. It is:

- durable across React unmounts, route changes, panel closure, and tab switching;
- not durable across host-renderer reload, host-renderer crash, window destruction, or application restart.

The logical `BrowserSession` and `BrowserTab` records survive host loss. The live page process state does not. When the host disappears, the environment server marks the host unavailable and tabs as lost rather than pretending the DOM, JavaScript heap, sockets, and history can be recovered.

## Evidence

The `renderer-reload` spike created both a renderer `<webview>` and a main-owned `WebContentsView`, modified state in each, and reloaded the host renderer:

- `<webview>` guest id changed from `2` to `4`, the first guest was destroyed, and count reset from `1` to `0`;
- `WebContentsView` retained id `3`, remained alive, and retained count `1`.

## Product Requirements

- Show an explicit "browser page was lost" state with last known URL, title, screenshot, and artifacts.
- Offer restart-and-restore as a new browser process, clearly reporting which state cannot be restored.
- Never silently bind a replacement guest to the old live-process identity.
- Bind every desktop browser host to one window id and define window-close as host loss.
- A future multi-window implementation must explicitly move or restart sessions; `<webview>` elements cannot be reparented across renderer documents.

## Rejected for This Iteration

Migrating the collaborative surface to `WebContentsView` solely for renderer-reload survival remains rejected because Phase 0 found hidden/detached recording and overlay composition unsuitable. The trade is now explicit: collaborative composition and recording are prioritized over host-renderer reload survival.
