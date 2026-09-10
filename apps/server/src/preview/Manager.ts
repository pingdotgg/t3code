/**
 * In-memory PreviewManager implementation.
 *
 * Sessions are keyed by `(threadId, tabId)`; a single thread can host
 * multiple tabs (browser-style). `open` always creates a new tab — tab
 * lifecycle is owned by the renderer.
 *
 * Events are published via Effect's `PubSub`, so subscriber failures are
 * isolated from the publishing call (a closed WS subscriber queue cannot
 * fail an in-progress `navigate()`).
 */
import {
  type PreviewAttachInput,
  type PreviewCloseInput,
  type PreviewEvent,
  type PreviewError,
  type PreviewFrameStreamEvent,
  PreviewInvalidUrlError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewPublishFrameInput,
  type PreviewRefreshInput,
  type PreviewReportStatusInput,
  type PreviewResizeInput,
  FILL_PREVIEW_VIEWPORT,
  PreviewSessionLookupError,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import {
  isPreviewUrlNormalizationError,
  newPreviewTabId,
  normalizePreviewUrl,
} from "@t3tools/shared/preview";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly open: (input: PreviewOpenInput) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly navigate: (
      input: PreviewNavigateInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly reportStatus: (input: PreviewReportStatusInput) => Effect.Effect<void, PreviewError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
    readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
    readonly events: Stream.Stream<PreviewEvent>;
    readonly subscribeEvents: Effect.Effect<PubSub.Subscription<PreviewEvent>, never, Scope.Scope>;
    /**
     * Frame stream for a viewer that cannot render the tab itself. Attaching
     * counts as demand; the last detach drops it back to zero.
     */
    readonly attachFrames: (
      input: PreviewAttachInput,
    ) => Effect.Effect<Stream.Stream<PreviewFrameStreamEvent>>;
    /** Host to server. Dropped when nothing is watching. */
    readonly publishFrame: (input: PreviewPublishFrameInput) => Effect.Effect<void>;
    /** Tells watchers why a tab produced no frames, without failing their stream. */
    readonly reportFramesUnavailable: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly reason: string;
    }) => Effect.Effect<void>;
    /**
     * Whether any frame has reached this tab's channel. Lets a caller tell a
     * host that is starting slowly from one that accepted the work and is
     * never going to deliver.
     */
    readonly hasDeliveredFrame: (input: {
      readonly threadId: string;
      readonly tabId: string;
    }) => Effect.Effect<boolean>;
    /** Demand transitions, for whoever is responsible for starting a host screencast. */
    readonly frameDemand: Stream.Stream<PreviewFrameDemand>;
    /** Current demand, so a host that connects late can be caught up. */
    readonly frameDemandSnapshot: Effect.Effect<ReadonlyArray<PreviewFrameDemand>>;
  }
>()("t3/preview/Manager/PreviewManager") {}

interface PreviewSessionState {
  readonly threadId: string;
  readonly tabId: string;
  readonly snapshot: PreviewSessionSnapshot;
}

/** How many viewers currently want frames for one tab. */
export interface PreviewFrameDemand {
  readonly threadId: PreviewAttachInput["threadId"];
  readonly tabId: PreviewAttachInput["tabId"];
  readonly viewers: number;
}

interface FrameChannel {
  readonly threadId: PreviewAttachInput["threadId"];
  readonly tabId: PreviewAttachInput["tabId"];
  readonly pubsub: PubSub.PubSub<PreviewFrameStreamEvent>;
  readonly viewers: number;
  /**
   * Whether any frame has reached this channel since a viewer arrived. A host
   * can accept a stream and then produce nothing, which is indistinguishable
   * from a slow start until something asks this question.
   */
  readonly delivered: boolean;
}

/**
 * Frames are lossy: a viewer only ever wants the newest one, so the channel
 * slides rather than buffering. Depth 2 absorbs a single slow tick without
 * letting a stalled subscriber pin decoded JPEGs in memory. This is the one
 * high-volume payload on the socket, so the drop policy is deliberate.
 */
const FRAME_CHANNEL_DEPTH = 2;

interface ManagerState {
  /** All sessions across every thread, keyed by `${threadId}\u0000${tabId}`. */
  readonly sessions: ReadonlyMap<string, PreviewSessionState>;
  /** Global monotonic revision establishing list/event ordering. */
  readonly revision: number;
}

const initialState: ManagerState = { sessions: new Map(), revision: 0 };

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

const compositeKey = (threadId: string, tabId: string): string => `${threadId}\u0000${tabId}`;

const sessionsForThread = (
  state: ManagerState,
  threadId: string,
): ReadonlyArray<PreviewSessionState> => {
  const out: PreviewSessionState[] = [];
  for (const session of state.sessions.values()) {
    if (session.threadId === threadId) out.push(session);
  }
  return out;
};

const normalizeUrl = (rawUrl: string): Effect.Effect<string, PreviewInvalidUrlError> =>
  Effect.try({
    try: () => normalizePreviewUrl(rawUrl),
    catch: (cause) => {
      if (isPreviewUrlNormalizationError(cause)) {
        return new PreviewInvalidUrlError({
          inputLength: cause.inputLength,
          reason: cause.reason,
          protocol: cause.protocol,
          cause,
        });
      }

      return new PreviewInvalidUrlError({
        inputLength: rawUrl.length,
        reason: "unexpected",
        cause,
      });
    },
  });

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const buildLoadingSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly viewport: PreviewViewportSetting;
  readonly profileId?: string | undefined;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  navStatus: { _tag: "Loading", url: input.url, title: input.title },
  canGoBack: false,
  canGoForward: false,
  viewport: input.viewport,
  ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  updatedAt: input.updatedAt,
});

const buildIdleSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly viewport: PreviewViewportSetting;
  readonly profileId?: string | undefined;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  viewport: input.viewport,
  ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  updatedAt: input.updatedAt,
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* PreviewManagerMake() {
  const serverEpoch = NodeCrypto.randomUUID();
  const stateRef = yield* SynchronizedRef.make<ManagerState>(initialState);
  // Unbounded PubSub is fine here — events are tiny and we don't want to
  // block publishers if a subscriber is slow. WS clients backpressure on
  // their own queues downstream.
  const eventsPubSub = yield* PubSub.unbounded<PreviewEvent>();
  const events: Stream.Stream<PreviewEvent> = Stream.fromPubSub(eventsPubSub);

  /**
   * Atomic read-modify-write over the session for `(threadId, tabId)`. The
   * mutator runs under the SynchronizedRef so concurrent writers cannot
   * interleave. Lookup failures travel through the modify result so both
   * branches yield the same `[A, S]` shape `modifyEffect` requires.
   *
   * The event is published INSIDE the lock so observers see events in the
   * same order as the underlying state transitions. Publishing an unbounded
   * PubSub is non-blocking, so this is cheap.
   */
  const mutateExistingSession = <R, E>(
    threadId: string,
    tabId: string,
    mutator: (
      session: PreviewSessionState,
    ) => Effect.Effect<{ next: PreviewSessionState; emit: PreviewEventDraft | null; result: R }, E>,
  ): Effect.Effect<R, E | PreviewSessionLookupError> => {
    type ModifyResult =
      | { kind: "fail"; error: PreviewSessionLookupError }
      | { kind: "ok"; result: R };

    return SynchronizedRef.modifyEffect(stateRef, (state) => {
      const session = state.sessions.get(compositeKey(threadId, tabId));
      if (!session) {
        return Effect.succeed([
          { kind: "fail", error: new PreviewSessionLookupError({ threadId, tabId }) },
          state,
        ] as readonly [ModifyResult, ManagerState]);
      }
      return mutator(session).pipe(
        Effect.flatMap(
          Effect.fn("PreviewManager.commitMutation")(function* ({ next, emit, result }) {
            const revision = emit ? state.revision + 1 : state.revision;
            if (emit) {
              yield* PubSub.publish(eventsPubSub, {
                ...emit,
                revision,
                serverEpoch,
              } as PreviewEvent);
            }
            const sessions = new Map(state.sessions);
            sessions.set(compositeKey(threadId, tabId), next);
            return [{ kind: "ok", result } as ModifyResult, { sessions, revision }] as readonly [
              ModifyResult,
              ManagerState,
            ];
          }),
        ),
      );
    }).pipe(
      Effect.flatMap((modify) =>
        modify.kind === "fail" ? Effect.fail(modify.error) : Effect.succeed(modify.result),
      ),
    );
  };

  const open: PreviewManager["Service"]["open"] = Effect.fn("PreviewManager.open")(
    function* (input) {
      const tabId = newPreviewTabId();
      const updatedAt = yield* currentIsoTimestamp;
      // Clients with a configured default send the viewport up front so the
      // session is born at the right size; older clients omit it and keep the
      // historical fill-panel behaviour.
      const viewport = input.viewport ?? FILL_PREVIEW_VIEWPORT;
      const snapshot = input.url
        ? buildLoadingSnapshot({
            threadId: input.threadId,
            tabId,
            url: yield* normalizeUrl(input.url),
            title: "",
            viewport,
            profileId: input.profileId,
            updatedAt,
          })
        : buildIdleSnapshot({
            threadId: input.threadId,
            tabId,
            viewport,
            profileId: input.profileId,
            updatedAt,
          });
      yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          const revision = state.revision + 1;
          const sessions = new Map(state.sessions);
          sessions.set(compositeKey(input.threadId, tabId), {
            threadId: input.threadId,
            tabId,
            snapshot,
          });
          yield* PubSub.publish(eventsPubSub, {
            type: "opened",
            threadId: input.threadId,
            tabId,
            createdAt: snapshot.updatedAt,
            serverEpoch,
            revision,
            snapshot,
          });
          return [snapshot, { sessions, revision }] as const;
        }),
      );
      return snapshot;
    },
  );

  const navigate: PreviewManager["Service"]["navigate"] = Effect.fn("PreviewManager.navigate")(
    function* (input) {
      const url = yield* normalizeUrl(input.url);
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.navigateSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const previousTitle =
            session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.title;
          const resolvedTitle = input.resolvedTitle ?? previousTitle;
          const snapshot: PreviewSessionSnapshot = {
            threadId: session.threadId,
            tabId: session.tabId,
            navStatus: { _tag: "Success", url, title: resolvedTitle },
            canGoBack: session.snapshot.canGoBack,
            canGoForward: session.snapshot.canGoForward,
            viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
            ...(session.snapshot.profileId === undefined
              ? {}
              : { profileId: session.snapshot.profileId }),
            updatedAt,
          };
          return {
            next: { ...session, snapshot },
            emit: {
              type: "navigated",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
    },
  );

  const reportStatus: PreviewManager["Service"]["reportStatus"] = Effect.fn(
    "PreviewManager.reportStatus",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.reportSessionStatus")(function* (session) {
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot: PreviewSessionSnapshot = {
          threadId: session.threadId,
          tabId: session.tabId,
          navStatus: input.navStatus,
          canGoBack: input.canGoBack,
          canGoForward: input.canGoForward,
          viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
          ...(session.snapshot.profileId === undefined
            ? {}
            : { profileId: session.snapshot.profileId }),
          updatedAt,
        };
        const emit: PreviewEventDraft =
          input.navStatus._tag === "LoadFailed"
            ? {
                type: "failed",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                url: input.navStatus.url,
                title: input.navStatus.title,
                code: input.navStatus.code,
                description: input.navStatus.description,
              }
            : {
                type: "navigated",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                snapshot,
              };
        return {
          next: { ...session, snapshot },
          emit,
          result: undefined as void,
        };
      }),
    );
  });

  const resize: PreviewManager["Service"]["resize"] = Effect.fn("PreviewManager.resize")(
    function* (input) {
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.resizeSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            viewport: input.viewport,
            updatedAt,
          };
          return {
            next: { ...session, snapshot },
            emit: {
              type: "resized",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
    },
  );

  const refresh: PreviewManager["Service"]["refresh"] = Effect.fn("PreviewManager.refresh")(
    function* (input) {
      // Verify the session exists; the desktop bridge handles the actual reload
      // and will report progress back via `reportStatus`. No event emitted.
      yield* mutateExistingSession(input.threadId, input.tabId, (session) =>
        Effect.succeed({ next: session, emit: null, result: undefined as void }),
      );
    },
  );

  const close: PreviewManager["Service"]["close"] = Effect.fn("PreviewManager.close")(
    function* (input) {
      const createdAt = yield* currentIsoTimestamp;
      yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        const eventsToEmit: PreviewEvent[] = [];
        const sessions = new Map(state.sessions);
        const targets = input.tabId
          ? [state.sessions.get(compositeKey(input.threadId, input.tabId))].filter(
              (entry): entry is PreviewSessionState => entry !== undefined,
            )
          : sessionsForThread(state, input.threadId);
        let revision = state.revision;
        for (const target of targets) {
          revision += 1;
          sessions.delete(compositeKey(target.threadId, target.tabId));
          eventsToEmit.push({
            type: "closed",
            threadId: target.threadId,
            tabId: target.tabId,
            createdAt,
            serverEpoch,
            revision,
          });
        }
        if (eventsToEmit.length === 0) {
          return Effect.succeed([undefined, state] as const);
        }
        return Effect.as(
          Effect.forEach(eventsToEmit, (event) => PubSub.publish(eventsPubSub, event), {
            discard: true,
          }),
          [undefined, { sessions, revision }] as const,
        );
      });
    },
  );

  // Frame channels live beside the session map rather than inside it: viewers
  // come and go far more often than sessions change, and folding them into
  // ManagerState would spin the revision counter that list/event ordering
  // depends on.
  const framesRef = yield* SynchronizedRef.make<ReadonlyMap<string, FrameChannel>>(new Map());
  const frameDemandPubSub = yield* PubSub.sliding<PreviewFrameDemand>(64);

  const readChannel = (threadId: string, tabId: string): Effect.Effect<FrameChannel | undefined> =>
    SynchronizedRef.get(framesRef).pipe(
      Effect.map((channels) => channels.get(compositeKey(threadId, tabId))),
    );

  const acquireViewer = Effect.fn("PreviewManager.acquireViewer")(function* (
    threadId: PreviewAttachInput["threadId"],
    tabId: PreviewAttachInput["tabId"],
  ) {
    const channel = yield* SynchronizedRef.modifyEffect(framesRef, (channels) =>
      Effect.gen(function* () {
        const key = compositeKey(threadId, tabId);
        const existing = channels.get(key);
        const pubsub =
          existing?.pubsub ?? (yield* PubSub.sliding<PreviewFrameStreamEvent>(FRAME_CHANNEL_DEPTH));
        const next: FrameChannel = {
          threadId,
          tabId,
          pubsub,
          viewers: (existing?.viewers ?? 0) + 1,
          delivered: existing?.delivered ?? false,
        };
        const updated = new Map(channels);
        updated.set(key, next);
        return [next, updated as ReadonlyMap<string, FrameChannel>] as const;
      }),
    );
    yield* PubSub.publish(frameDemandPubSub, { threadId, tabId, viewers: channel.viewers });
    return channel;
  });

  const releaseViewer = Effect.fn("PreviewManager.releaseViewer")(function* (
    threadId: PreviewAttachInput["threadId"],
    tabId: PreviewAttachInput["tabId"],
  ) {
    const released = yield* SynchronizedRef.modify(framesRef, (channels) => {
      const key = compositeKey(threadId, tabId);
      const existing = channels.get(key);
      if (!existing) {
        return [null, channels] as const;
      }
      const viewers = Math.max(0, existing.viewers - 1);
      const updated = new Map(channels);
      if (viewers === 0) {
        updated.delete(key);
      } else {
        updated.set(key, { ...existing, viewers });
      }
      return [
        { pubsub: existing.pubsub, viewers },
        updated as ReadonlyMap<string, FrameChannel>,
      ] as const;
    });
    if (!released) return;
    yield* PubSub.publish(frameDemandPubSub, { threadId, tabId, viewers: released.viewers });
    if (released.viewers === 0) {
      yield* PubSub.shutdown(released.pubsub);
    }
  });

  const attachFrames: PreviewManager["Service"]["attachFrames"] = Effect.fn(
    "PreviewManager.attachFrames",
  )((input) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireViewer(input.threadId, input.tabId), () =>
          releaseViewer(input.threadId, input.tabId),
        ).pipe(
          Effect.map((channel) =>
            Stream.concat(
              Stream.succeed<PreviewFrameStreamEvent>({
                _tag: "attached",
                threadId: input.threadId,
                tabId: input.tabId,
              }),
              Stream.fromPubSub(channel.pubsub),
            ),
          ),
        ),
      ),
    ),
  );

  const publishFrame: PreviewManager["Service"]["publishFrame"] = Effect.fn(
    "PreviewManager.publishFrame",
  )(function* (input) {
    const channel = yield* readChannel(input.threadId, input.tabId);
    // No viewers means the host is still winding down its screencast. Dropping
    // is correct: there is nobody to render the frame.
    if (!channel) return;
    if (!channel.delivered) {
      yield* SynchronizedRef.update(framesRef, (channels) => {
        const key = compositeKey(input.threadId, input.tabId);
        const current = channels.get(key);
        if (!current || current.delivered) return channels;
        const updated = new Map(channels);
        updated.set(key, { ...current, delivered: true });
        return updated;
      });
    }
    yield* PubSub.publish(channel.pubsub, { _tag: "frame", frame: input });
  });

  const hasDeliveredFrame: PreviewManager["Service"]["hasDeliveredFrame"] = Effect.fn(
    "PreviewManager.hasDeliveredFrame",
  )(function* (input) {
    const channel = yield* readChannel(input.threadId, input.tabId);
    return channel?.delivered ?? false;
  });

  const reportFramesUnavailable: PreviewManager["Service"]["reportFramesUnavailable"] = Effect.fn(
    "PreviewManager.reportFramesUnavailable",
  )(function* (input) {
    const channel = yield* readChannel(input.threadId, input.tabId);
    if (!channel) return;
    yield* PubSub.publish(channel.pubsub, {
      _tag: "unavailable",
      threadId: input.threadId,
      tabId: input.tabId,
      reason: input.reason,
    });
  });

  const frameDemandSnapshot: PreviewManager["Service"]["frameDemandSnapshot"] = SynchronizedRef.get(
    framesRef,
  ).pipe(
    Effect.map((channels) =>
      Array.from(channels.values()).map((channel): PreviewFrameDemand => ({
        threadId: channel.threadId,
        tabId: channel.tabId,
        viewers: channel.viewers,
      })),
    ),
  );

  const list: PreviewManager["Service"]["list"] = Effect.fn("PreviewManager.list")(
    function* (input) {
      return yield* SynchronizedRef.get(stateRef).pipe(
        Effect.map((state): PreviewListResult => ({
          sessions: sessionsForThread(state, input.threadId)
            .map((s) => s.snapshot)
            .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
          serverEpoch,
          revision: state.revision,
        })),
      );
    },
  );

  return PreviewManager.of({
    open,
    navigate,
    reportStatus,
    resize,
    refresh,
    close,
    list,
    events,
    subscribeEvents: PubSub.subscribe(eventsPubSub),
    attachFrames,
    publishFrame,
    reportFramesUnavailable,
    hasDeliveredFrame,
    frameDemand: Stream.fromPubSub(frameDemandPubSub),
    frameDemandSnapshot,
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
