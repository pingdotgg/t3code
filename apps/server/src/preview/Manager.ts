import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewCloseInput,
  type PreviewDiscoverLocalServersInput,
  type PreviewDiscoverLocalServersResult,
  type PreviewEvent,
  type PreviewInvalidUrlError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewRefreshInput,
  type PreviewReportStatusInput,
  type PreviewResizeInput,
  PreviewSessionLookupError,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { newPreviewTabId, normalizePreviewUrl } from "@t3tools/shared/preview";
import { Context, Effect, Layer, PubSub, Schema, Stream, SynchronizedRef } from "effect";

export interface PreviewManagerShape {
  readonly open: (
    input: PreviewOpenInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewInvalidUrlError>;
  readonly navigate: (
    input: PreviewNavigateInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewInvalidUrlError | PreviewSessionLookupError>;
  readonly reportStatus: (
    input: PreviewReportStatusInput,
  ) => Effect.Effect<void, PreviewSessionLookupError>;
  readonly resize: (
    input: PreviewResizeInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewSessionLookupError>;
  readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewSessionLookupError>;
  readonly close: (input: PreviewCloseInput) => Effect.Effect<void>;
  readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
  readonly discoverLocalServers: (
    input: PreviewDiscoverLocalServersInput,
  ) => Effect.Effect<PreviewDiscoverLocalServersResult>;
  readonly subscribe: () => Stream.Stream<PreviewEvent>;
}

export class PreviewManager extends Context.Service<PreviewManager, PreviewManagerShape>()(
  "t3/preview/Manager",
) {}

interface PreviewManagerState {
  readonly sessionsByThread: ReadonlyMap<string, ReadonlyMap<string, PreviewSessionSnapshot>>;
}

const EMPTY_STATE: PreviewManagerState = {
  sessionsByThread: new Map(),
};

const DEFAULT_PREVIEW_URL = "http://localhost:3000/";
const DEFAULT_LOCAL_SERVER_PORTS = [
  3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 6006, 7000, 8000, 8080, 8787,
] as const;
const LOCAL_SERVER_SCAN_TIMEOUT_MS = 650;
const isPreviewSessionLookupError = Schema.is(PreviewSessionLookupError);
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

function nowIso(): string {
  return new Date().toISOString();
}

function loadingSnapshot(input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly viewport?: PreviewSessionSnapshot["viewport"];
}): PreviewSessionSnapshot {
  return {
    threadId: input.threadId,
    tabId: input.tabId,
    navStatus: {
      _tag: "Loading",
      url: input.url,
      title: input.title,
    },
    canGoBack: false,
    canGoForward: false,
    viewport: input.viewport ?? FILL_PREVIEW_VIEWPORT,
    updatedAt: nowIso(),
  };
}

function getThreadSessions(
  state: PreviewManagerState,
  threadId: string,
): ReadonlyMap<string, PreviewSessionSnapshot> {
  return state.sessionsByThread.get(threadId) ?? new Map();
}

function putSession(
  state: PreviewManagerState,
  snapshot: PreviewSessionSnapshot,
): PreviewManagerState {
  const sessionsByThread = new Map(state.sessionsByThread);
  const threadSessions = new Map(getThreadSessions(state, snapshot.threadId));
  threadSessions.set(snapshot.tabId, snapshot);
  sessionsByThread.set(snapshot.threadId, threadSessions);
  return { sessionsByThread };
}

function removeSessions(
  state: PreviewManagerState,
  input: PreviewCloseInput,
): { readonly state: PreviewManagerState; readonly closed: ReadonlyArray<PreviewSessionSnapshot> } {
  const threadSessions = getThreadSessions(state, input.threadId);
  if (threadSessions.size === 0) {
    return { state, closed: [] };
  }

  const nextThreadSessions = new Map(threadSessions);
  const closed =
    input.tabId === undefined
      ? Array.from(threadSessions.values())
      : threadSessions.get(input.tabId)
        ? [threadSessions.get(input.tabId)!]
        : [];

  if (input.tabId === undefined) {
    nextThreadSessions.clear();
  } else {
    nextThreadSessions.delete(input.tabId);
  }

  const sessionsByThread = new Map(state.sessionsByThread);
  if (nextThreadSessions.size === 0) {
    sessionsByThread.delete(input.threadId);
  } else {
    sessionsByThread.set(input.threadId, nextThreadSessions);
  }

  return { state: { sessionsByThread }, closed };
}

function getRequiredSession(
  state: PreviewManagerState,
  threadId: string,
  tabId: string,
): PreviewSessionSnapshot | PreviewSessionLookupError {
  const session = getThreadSessions(state, threadId).get(tabId);
  if (!session) {
    return new PreviewSessionLookupError({ threadId, tabId });
  }
  return session;
}

function normalizeScanPorts(input: PreviewDiscoverLocalServersInput): readonly number[] {
  const ports = input.ports ?? DEFAULT_LOCAL_SERVER_PORTS;
  return [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

async function probeLocalServer(input: {
  readonly host: string;
  readonly port: number;
}): Promise<PreviewDiscoverLocalServersResult["servers"][number] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_SERVER_SCAN_TIMEOUT_MS);
  const url = `http://${input.host}:${input.port}/`;
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("text/html") ? await response.text() : "";
    const title = TITLE_RE.exec(body)?.[1]?.trim();
    return {
      url,
      host: input.host,
      port: input.port,
      ...(title ? { title } : {}),
      status: response.status,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function makePreviewManager(): Effect.Effect<PreviewManagerShape> {
  return Effect.gen(function* () {
    const stateRef = yield* SynchronizedRef.make<PreviewManagerState>(EMPTY_STATE);
    const events = yield* PubSub.unbounded<PreviewEvent>();

    const publish = (event: PreviewEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

    const updateExistingSession = (
      input: {
        readonly threadId: string;
        readonly tabId: string;
        readonly type: "navigated" | "resized";
      },
      mutate: (current: PreviewSessionSnapshot) => PreviewSessionSnapshot,
    ): Effect.Effect<PreviewSessionSnapshot, PreviewSessionLookupError> =>
      SynchronizedRef.modifyEffect(
        stateRef,
        (
          state,
        ): Effect.Effect<
          readonly [PreviewSessionSnapshot, PreviewManagerState],
          PreviewSessionLookupError
        > => {
          const current = getRequiredSession(state, input.threadId, input.tabId);
          if (isPreviewSessionLookupError(current)) {
            return Effect.fail(current);
          }
          const next = mutate(current);
          return Effect.succeed([next, putSession(state, next)] as const);
        },
      ).pipe(
        Effect.tap((snapshot) =>
          publish({
            type: input.type,
            threadId: snapshot.threadId,
            tabId: snapshot.tabId,
            snapshot,
            createdAt: nowIso(),
          }),
        ),
      );

    return {
      open: (input) =>
        Effect.gen(function* () {
          const normalized = normalizePreviewUrl(input.url ?? DEFAULT_PREVIEW_URL);
          if (typeof normalized !== "string") {
            return yield* normalized;
          }
          const snapshot = loadingSnapshot({
            threadId: input.threadId,
            tabId: newPreviewTabId(),
            url: normalized,
            title: normalized,
          });
          yield* SynchronizedRef.update(stateRef, (state) => putSession(state, snapshot));
          yield* publish({
            type: "opened",
            threadId: snapshot.threadId,
            tabId: snapshot.tabId,
            snapshot,
            createdAt: nowIso(),
          });
          return snapshot;
        }),
      navigate: (input) =>
        Effect.gen(function* () {
          const normalized = normalizePreviewUrl(input.url);
          if (typeof normalized !== "string") {
            return yield* normalized;
          }
          return yield* updateExistingSession(
            { threadId: input.threadId, tabId: input.tabId, type: "navigated" },
            (current) => {
              return {
                ...current,
                navStatus: {
                  _tag: "Loading",
                  url: normalized,
                  title: input.resolvedTitle ?? normalized,
                },
                updatedAt: nowIso(),
              };
            },
          );
        }),
      reportStatus: (input) =>
        SynchronizedRef.modifyEffect(
          stateRef,
          (
            state,
          ): Effect.Effect<
            readonly [PreviewSessionSnapshot, PreviewManagerState],
            PreviewSessionLookupError
          > => {
            const current = getRequiredSession(state, input.threadId, input.tabId);
            if (isPreviewSessionLookupError(current)) {
              return Effect.fail(current);
            }
            const snapshot: PreviewSessionSnapshot = {
              ...current,
              navStatus: input.navStatus,
              canGoBack: input.canGoBack,
              canGoForward: input.canGoForward,
              updatedAt: nowIso(),
            };
            return Effect.succeed([snapshot, putSession(state, snapshot)] as const);
          },
        ).pipe(
          Effect.flatMap((snapshot) => {
            const event: PreviewEvent =
              snapshot.navStatus._tag === "LoadFailed"
                ? {
                    type: "failed",
                    threadId: snapshot.threadId,
                    tabId: snapshot.tabId,
                    url: snapshot.navStatus.url,
                    title: snapshot.navStatus.title,
                    code: snapshot.navStatus.code,
                    description: snapshot.navStatus.description,
                    createdAt: nowIso(),
                  }
                : {
                    type: "navigated",
                    threadId: snapshot.threadId,
                    tabId: snapshot.tabId,
                    snapshot,
                    createdAt: nowIso(),
                  };
            return publish(event);
          }),
        ),
      resize: (input) =>
        updateExistingSession(
          { threadId: input.threadId, tabId: input.tabId, type: "resized" },
          (current) => ({
            ...current,
            viewport: input.viewport,
            updatedAt: nowIso(),
          }),
        ),
      refresh: (input) =>
        SynchronizedRef.modifyEffect(
          stateRef,
          (
            state,
          ): Effect.Effect<
            readonly [PreviewSessionSnapshot, PreviewManagerState],
            PreviewSessionLookupError
          > => {
            const current = getRequiredSession(state, input.threadId, input.tabId);
            if (isPreviewSessionLookupError(current)) {
              return Effect.fail(current);
            }
            const snapshot = { ...current, updatedAt: nowIso() };
            return Effect.succeed([snapshot, putSession(state, snapshot)] as const);
          },
        ).pipe(
          Effect.flatMap((snapshot) =>
            publish({
              type: "navigated",
              threadId: snapshot.threadId,
              tabId: snapshot.tabId,
              snapshot,
              createdAt: nowIso(),
            }),
          ),
        ),
      close: (input) =>
        SynchronizedRef.modify(stateRef, (state) => {
          const result = removeSessions(state, input);
          return [result.closed, result.state] as const;
        }).pipe(
          Effect.flatMap((closed) =>
            Effect.forEach(
              closed,
              (snapshot) =>
                publish({
                  type: "closed",
                  threadId: snapshot.threadId,
                  tabId: snapshot.tabId,
                  createdAt: nowIso(),
                }),
              { discard: true },
            ),
          ),
        ),
      list: (input) =>
        SynchronizedRef.get(stateRef).pipe(
          Effect.map(
            (state): PreviewListResult => ({
              sessions: Array.from(getThreadSessions(state, input.threadId).values()),
            }),
          ),
        ),
      discoverLocalServers: (input) =>
        Effect.promise(async (): Promise<PreviewDiscoverLocalServersResult> => {
          const host = input.host?.trim() || "localhost";
          const ports = normalizeScanPorts(input);
          const probed = await Promise.all(ports.map((port) => probeLocalServer({ host, port })));
          return {
            servers: probed
              .filter((server): server is NonNullable<typeof server> => server !== null)
              .toSorted((a, b) => a.port - b.port),
          };
        }),
      subscribe: () => Stream.fromPubSub(events),
    };
  });
}

export const PreviewManagerLive = Layer.effect(PreviewManager, makePreviewManager());
