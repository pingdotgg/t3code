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
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentSession, usePreparedConnection } from "./session";

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);

interface ThreadPreviewTabs {
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

const MAX_REPLAY_EVENTS = 200;

function applyEvent(current: ThreadPreviewTabs, event: PreviewEvent): ThreadPreviewTabs {
  if (event.revision <= current.revision) return current;
  const index = current.sessions.findIndex((session) => session.tabId === event.tabId);
  const sessions = [...current.sessions];
  if (event.type === "closed") {
    if (index !== -1) sessions.splice(index, 1);
  } else if (event.type === "failed") {
    const existing = sessions[index];
    if (existing) {
      sessions[index] = {
        ...existing,
        navStatus: {
          _tag: "LoadFailed",
          url: event.url,
          title: event.title,
          code: event.code,
          description: event.description,
        },
        updatedAt: event.createdAt,
      };
    }
  } else {
    // Keep a tab's place so the picker order is stable.
    sessions[index === -1 ? sessions.length : index] = event.snapshot;
  }
  return { ...current, serverEpoch: event.serverEpoch, revision: event.revision, sessions };
}

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
    // Lists can land after events they predate; replay newer events on each list.
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
      return events.reduce<ThreadPreviewTabs>(applyEvent, { ...result, listed: true });
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

export function usePreviewStreamAccess(environmentId: EnvironmentId) {
  const prepared = usePreparedConnection(environmentId);
  const query = useEnvironmentQuery(previewStreamAccessAtom(environmentId));
  const access = query.data && query.error === null && Option.isSome(prepared) ? query.data : null;
  return { access, error: query.error, refresh: query.refresh };
}
