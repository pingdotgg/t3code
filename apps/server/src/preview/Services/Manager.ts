/**
 * PreviewManager - Per-thread browser preview session orchestration.
 *
 * Owns metadata-only preview sessions keyed by `(threadId, tabId)`. A thread
 * can host multiple concurrent tabs (browser-style). The actual Chromium
 * <webview> lives in the desktop renderer; this service tracks the canonical
 * URL/title/nav state per tab so sessions survive reconnects and are visible
 * to multiple connected clients.
 *
 * Event delivery uses Effect's `PubSub` so listener failures (e.g. a
 * disconnected WS subscriber's queue being closed) cannot propagate back
 * into the mutating call's failure channel — matches the codebase
 * convention used by `SessionCredentialService`.
 *
 * @module PreviewManager
 */
import {
  type PreviewCloseInput,
  type PreviewError,
  type PreviewEvent,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewRefreshInput,
  type PreviewReportStatusInput,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { Context, type Effect, type PubSub, type Scope, type Stream } from "effect";

export interface PreviewManagerShape {
  /**
   * Open a brand new preview tab for `threadId`. When `url` is omitted the
   * tab starts in the `Idle` state so the user can type into the URL bar;
   * otherwise it transitions straight to `Loading`. Always emits `opened`.
   */
  readonly open: (input: PreviewOpenInput) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;

  /**
   * Update the session's URL/title from the renderer (after the <webview>
   * resolved navigation, including redirects). Emits a `navigated` event.
   */
  readonly navigate: (
    input: PreviewNavigateInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;

  /**
   * Renderer reports current nav status (Loading/Success/LoadFailed) and
   * back/forward availability. Drives `failed` and `navigated` events.
   */
  readonly reportStatus: (input: PreviewReportStatusInput) => Effect.Effect<void, PreviewError>;

  /**
   * Renderer requested a reload. Server records intent (no state change) so
   * subscribers can reconcile if needed; the desktop bridge actually reloads.
   */
  readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;

  /**
   * Close the session (drop server-side state, emit `closed`). When `tabId`
   * is omitted, closes every session for the thread.
   */
  readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;

  /**
   * List active preview sessions for a thread. Returns an empty array when
   * the thread has no sessions.
   */
  readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;

  /**
   * Stream of preview events. Each subscriber gets its own buffered stream;
   * subscriber failures are isolated and do not affect other subscribers
   * or publishers.
   *
   * NOTE: `Stream.fromPubSub` defers `PubSub.subscribe` until the stream
   * starts running, so `Stream.runForEach(...).pipe(Effect.forkScoped)` may
   * miss a publish landing between fork and stream-start. Callers that
   * cannot tolerate this gap should use `subscribeEvents` below.
   */
  readonly events: Stream.Stream<PreviewEvent>;

  /**
   * Acquire a PubSub subscription synchronously in the caller's fiber so
   * no publish can land in the narrow gap between subscribe and consumer
   * loop start. The subscription's lifetime is bound to the provided
   * `Scope`; release happens automatically on scope close.
   */
  readonly subscribeEvents: Effect.Effect<PubSub.Subscription<PreviewEvent>, never, Scope.Scope>;
}

export class PreviewManager extends Context.Service<PreviewManager, PreviewManagerShape>()(
  "t3/preview/Services/Manager/PreviewManager",
) {}
