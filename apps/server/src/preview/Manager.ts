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
  type PreviewBrowserEngine,
  type PreviewCloseInput,
  type PreviewEvent,
  type PreviewError,
  type PreviewInputInput,
  PreviewInvalidUrlError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
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

import { PlaywrightPreviewHost } from "../mcp/PlaywrightPreviewHost.ts";

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
    /** Forwards user input to an engine page. No-op for docked tabs. */
    readonly input: (input: PreviewInputInput) => Effect.Effect<void, PreviewError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
    readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
    readonly events: Stream.Stream<PreviewEvent>;
    readonly subscribeEvents: Effect.Effect<PubSub.Subscription<PreviewEvent>, never, Scope.Scope>;
  }
>()("t3/preview/Manager/PreviewManager") {}

interface PreviewSessionState {
  readonly threadId: string;
  readonly tabId: string;
  readonly snapshot: PreviewSessionSnapshot;
}

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

const buildSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly navStatus: PreviewSessionSnapshot["navStatus"];
  readonly viewport: PreviewViewportSetting;
  readonly profileId?: string | undefined;
  readonly engine?: PreviewBrowserEngine | undefined;
  readonly frameUrl?: string | undefined;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  navStatus: input.navStatus,
  canGoBack: false,
  canGoForward: false,
  viewport: input.viewport,
  ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  ...(input.engine === undefined ? {} : { engine: input.engine }),
  ...(input.frameUrl === undefined ? {} : { frameUrl: input.frameUrl }),
  updatedAt: input.updatedAt,
});

/** Fields fixed at open. `navigate` and `reportStatus` rebuild the snapshot and must keep them. */
const fixedFields = (snapshot: PreviewSessionSnapshot) => ({
  viewport: snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
  ...(snapshot.profileId === undefined ? {} : { profileId: snapshot.profileId }),
  ...(snapshot.engine === undefined ? {} : { engine: snapshot.engine }),
  ...(snapshot.frameUrl === undefined ? {} : { frameUrl: snapshot.frameUrl }),
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* PreviewManagerMake() {
  const host = yield* PlaywrightPreviewHost;
  const scope = yield* Effect.scope;
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
      const url = input.url === undefined ? undefined : yield* normalizeUrl(input.url);
      const view =
        input.engine === undefined
          ? undefined
          : yield* host.openView({
              owner: `view:${input.threadId}`,
              engine: input.engine,
              url,
            });
      const tabId = view?.tabId ?? newPreviewTabId();
      const updatedAt = yield* currentIsoTimestamp;
      // Clients with a configured default send the viewport up front so the
      // session is born at the right size; older clients omit it and keep the
      // historical fill-panel behaviour.
      const snapshot = buildSnapshot({
        threadId: input.threadId,
        tabId,
        navStatus: url === undefined ? { _tag: "Idle" } : { _tag: "Loading", url, title: "" },
        viewport: input.viewport ?? FILL_PREVIEW_VIEWPORT,
        profileId: input.engine === undefined ? input.profileId : undefined,
        engine: input.engine,
        frameUrl: view?.frameUrl,
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
      if (view !== undefined) {
        yield* Stream.runForEach(view.events, (event) =>
          event.type === "closed"
            ? close({ threadId: input.threadId, tabId })
            : reportStatus({
                threadId: input.threadId,
                tabId,
                navStatus: event.navStatus,
                canGoBack: event.canGoBack,
                canGoForward: event.canGoForward,
              }).pipe(Effect.ignore),
        ).pipe(Effect.forkIn(scope));
      }
      return snapshot;
    },
  );

  const navigate: PreviewManager["Service"]["navigate"] = Effect.fn("PreviewManager.navigate")(
    function* (input) {
      const url = yield* normalizeUrl(input.url);
      const snapshot = yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.navigateSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const previousTitle =
            session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.title;
          const resolvedTitle = input.resolvedTitle ?? previousTitle;
          // The docked view navigates itself and reports back. An engine page
          // navigates below, so its status starts at Loading.
          const snapshot: PreviewSessionSnapshot = {
            threadId: session.threadId,
            tabId: session.tabId,
            navStatus:
              session.snapshot.engine === undefined
                ? { _tag: "Success", url, title: resolvedTitle }
                : { _tag: "Loading", url, title: "" },
            canGoBack: session.snapshot.canGoBack,
            canGoForward: session.snapshot.canGoForward,
            ...fixedFields(session.snapshot),
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
      if (snapshot.engine !== undefined) {
        yield* Effect.forkIn(host.navigateView(input.tabId, url), scope);
      }
      return snapshot;
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
          ...fixedFields(session.snapshot),
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
      const snapshot = yield* mutateExistingSession(
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
      if (snapshot.engine !== undefined) {
        yield* Effect.forkIn(host.resizeView(input.tabId, input.viewport), scope);
      }
      return snapshot;
    },
  );

  const input: PreviewManager["Service"]["input"] = Effect.fn("PreviewManager.input")(
    function* (request) {
      const engine = yield* mutateExistingSession(request.threadId, request.tabId, (session) =>
        Effect.succeed({ next: session, emit: null, result: session.snapshot.engine }),
      );
      if (engine !== undefined) yield* host.sendInput(request.tabId, request.event);
    },
  );

  const refresh: PreviewManager["Service"]["refresh"] = Effect.fn("PreviewManager.refresh")(
    function* (input) {
      // The desktop bridge reloads the docked view itself and reports progress
      // back via `reportStatus`. No event emitted.
      const engine = yield* mutateExistingSession(input.threadId, input.tabId, (session) =>
        Effect.succeed({ next: session, emit: null, result: session.snapshot.engine }),
      );
      if (engine !== undefined) yield* Effect.forkIn(host.reloadView(input.tabId), scope);
    },
  );

  const close: PreviewManager["Service"]["close"] = Effect.fn("PreviewManager.close")(
    function* (input) {
      const createdAt = yield* currentIsoTimestamp;
      const closed = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
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
          return Effect.succeed([targets, state] as const);
        }
        return Effect.as(
          Effect.forEach(eventsToEmit, (event) => PubSub.publish(eventsPubSub, event), {
            discard: true,
          }),
          [targets, { sessions, revision }] as const,
        );
      });
      yield* Effect.forEach(
        closed.filter((target) => target.snapshot.engine !== undefined),
        (target) => Effect.forkIn(host.closeView(target.tabId), scope),
        { discard: true },
      );
    },
  );

  const list: PreviewManager["Service"]["list"] = Effect.fn("PreviewManager.list")(
    function* (input) {
      const engines = yield* host.installedEngines;
      return yield* SynchronizedRef.get(stateRef).pipe(
        Effect.map((state): PreviewListResult => ({
          sessions: sessionsForThread(state, input.threadId)
            .map((s) => s.snapshot)
            .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
          serverEpoch,
          revision: state.revision,
          engines,
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
    input,
    close,
    list,
    events,
    subscribeEvents: PubSub.subscribe(eventsPubSub),
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
