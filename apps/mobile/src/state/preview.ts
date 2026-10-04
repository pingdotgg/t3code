import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { PREVIEW_STREAM_BASE_PATH } from "@t3tools/client-runtime/preview/server-browser-stream";
import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview";
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type {
  EnvironmentId,
  PreviewEvent,
  PreviewListResult,
  PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { environmentSession, usePreparedConnection } from "./session";

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);

interface ThreadPreviewTabs {
  /** Null until the first list result or event arrives. */
  readonly serverEpoch: string | null;
  readonly revision: number;
  readonly sessions: ReadonlyArray<PreviewSessionSnapshot>;
  /** A list result has arrived, so `sessions` covers tabs opened before this view. */
  readonly listed: boolean;
}

const EMPTY_TABS: ThreadPreviewTabs = {
  serverEpoch: null,
  revision: 0,
  sessions: [],
  listed: false,
};
const emptyTabsAtom = Atom.make(EMPTY_TABS).pipe(Atom.withLabel("mobile-preview-tabs:empty"));

// Events kept for replay onto a list that lands after them. Only a list older
// than this many of the thread's events would miss one.
const MAX_REPLAY_EVENTS = 200;

const listTabs = (result: PreviewListResult): ThreadPreviewTabs => ({
  serverEpoch: result.serverEpoch,
  revision: result.revision,
  sessions: result.sessions,
  listed: true,
});

function applyEvent(current: ThreadPreviewTabs, event: PreviewEvent): ThreadPreviewTabs {
  if (event.revision <= current.revision) return current;
  const others = current.sessions.filter((session) => session.tabId !== event.tabId);
  const existing = current.sessions.find((session) => session.tabId === event.tabId);
  const sessions = (() => {
    switch (event.type) {
      case "opened":
      case "navigated":
      case "resized":
        // Keep a tab's place so the picker order is stable.
        return existing
          ? current.sessions.map((session) =>
              session.tabId === event.tabId ? event.snapshot : session,
            )
          : [...others, event.snapshot];
      case "failed":
        return existing
          ? current.sessions.map((session) =>
              session.tabId === event.tabId
                ? {
                    ...session,
                    navStatus: {
                      _tag: "LoadFailed" as const,
                      url: event.url,
                      title: event.title,
                      code: event.code,
                      description: event.description,
                    },
                    updatedAt: event.createdAt,
                  }
                : session,
            )
          : current.sessions;
      case "closed":
        return others;
    }
  })();
  return { ...current, serverEpoch: event.serverEpoch, revision: event.revision, sessions };
}

/**
 * One thread's preview tabs: the `preview.list` result kept current by
 * environment preview events, the same pairing web's preview session sync uses.
 */
const threadPreviewTabsAtom = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  if (ref === null) return emptyTabsAtom;
  const listAtom = previewEnvironment.list({
    environmentId: ref.environmentId,
    input: { threadId: ref.threadId },
  });
  const eventsAtom = previewEnvironment.events({ environmentId: ref.environmentId, input: {} });
  return Atom.make((get) => {
    let disposed = false;
    let state = EMPTY_TABS;
    // The newest list applied, and this thread's events newer than it. A list
    // can land after events it predates (the first one, or a stale cached one
    // then its refresh), so each list is the base and newer events replay on top.
    let list: PreviewListResult | null = null;
    let events: ReadonlyArray<PreviewEvent> = [];
    const publish = (next: ThreadPreviewTabs) => {
      if (next === state) return;
      state = next;
      get.setSelf(next);
    };
    const applyList = (result: PreviewListResult) => {
      if (list?.serverEpoch === result.serverEpoch && result.revision < list.revision) return;
      list = result;
      events = events.filter(
        (event) => event.serverEpoch === result.serverEpoch && event.revision > result.revision,
      );
      return events.reduce(applyEvent, listTabs(result));
    };
    get.addFinalizer(() => {
      disposed = true;
    });
    get.subscribe(listAtom, (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const next = applyList(result.value);
      if (next) publish(next);
    });
    get.subscribe(eventsAtom, (result) => {
      if (!AsyncResult.isSuccess(result) || result.value.threadId !== ref.threadId) return;
      const event = result.value;
      if (list?.serverEpoch === event.serverEpoch && event.revision <= list.revision) return;
      events = [...events.slice(1 - MAX_REPLAY_EVENTS), event];
      // A restarted server resets revisions; only a fresh list is authoritative.
      if (state.serverEpoch !== null && event.serverEpoch !== state.serverEpoch) {
        get.refresh(listAtom);
        return;
      }
      publish(applyEvent(state, event));
    });
    get.mount(listAtom);
    get.mount(eventsAtom);
    const cached = get.once(listAtom);
    if (AsyncResult.isSuccess(cached)) state = applyList(cached.value) ?? state;
    // The cached list can predate an agent-opened tab.
    queueMicrotask(() => {
      if (!disposed) get.refresh(listAtom);
    });
    return state;
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`mobile-preview-tabs:${threadKey}`));
});

/** The thread's server-hosted browser tabs. `loaded` turns true once the tab list has arrived. */
export function useThreadServerBrowserTabs(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly enabled: boolean;
}) {
  const tabs = useAtomValue(
    input.enabled
      ? threadPreviewTabsAtom(
          scopedThreadKey({ environmentId: input.environmentId, threadId: input.threadId }),
        )
      : emptyTabsAtom,
  );
  const sessions = useMemo(
    () => tabs.sessions.filter((session) => session.runtime === "server"),
    [tabs.sessions],
  );
  return { tabs: sessions, loaded: tabs.listed };
}

const previewStreamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      return prepared === null
        ? Effect.never
        : resolveDeviceHubAccess({ prepared, hubBasePath: PREVIEW_STREAM_BASE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`mobile-preview-stream-access:${environmentId}`)),
);

/** Fetches a fresh stream ticket; a refused socket calls this before reconnecting. */
export function refreshPreviewStreamAccess(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(previewStreamAccessAtom(environmentId));
}

/** Stream credentials for server tabs, with the same ticket flow as the device hub. */
export function usePreviewStreamAccess(environmentId: EnvironmentId) {
  const prepared = usePreparedConnection(environmentId);
  const query = useEnvironmentQuery(previewStreamAccessAtom(environmentId));
  const access = query.data && query.error === null && Option.isSome(prepared) ? query.data : null;
  return { access, error: query.error, refresh: query.refresh };
}
