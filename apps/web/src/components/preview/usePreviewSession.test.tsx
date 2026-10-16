import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  type PreviewEvent,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Stand-ins for the environment's preview queries, keyed like the real atom families.
const queryAtoms = vi.hoisted(
  () => new Map<string, Atom.Writable<AsyncResult.AsyncResult<unknown>>>(),
);

vi.mock("~/env", () => ({ isElectron: true }));

vi.mock("~/state/preview", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const query = (key: string) => {
    let atom = queryAtoms.get(key);
    if (!atom) {
      atom = Atom.make<AsyncResult.AsyncResult<unknown>>(AsyncResult.initial()).pipe(
        Atom.keepAlive,
      );
      queryAtoms.set(key, atom);
    }
    return atom;
  };
  return {
    previewEnvironment: {
      events: ({ environmentId }: { environmentId: string }) => query(`events:${environmentId}`),
      list: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
        query(`list:${environmentId}:${input.threadId}`),
    },
  };
});

import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { useDesktopHostedPreviewSessions } from "./usePreviewSession";

const environmentId = EnvironmentId.make("env-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-background"));

const snapshot: PreviewSessionSnapshot = {
  threadId: "thread-background",
  tabId: "tab_agent",
  navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function Host() {
  useDesktopHostedPreviewSessions(environmentId);
  return null;
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetPreviewStateForTests();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("useDesktopHostedPreviewSessions", () => {
  it("tracks tabs an agent opens in a thread whose chat is not mounted", async () => {
    await act(async () => {
      renderer = create(createElement(AppAtomRegistryProvider, null, createElement(Host)));
    });
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});

    const opened: PreviewEvent = {
      type: "opened",
      threadId: "thread-background",
      tabId: "tab_agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
      snapshot,
    };
    await act(async () => {
      appAtomRegistry.set(queryAtoms.get(`events:${environmentId}`)!, AsyncResult.success(opened));
    });

    // The thread's own sync is now running, so its list and events reach the store.
    expect(queryAtoms.has(`list:${environmentId}:thread-background`)).toBe(true);
    expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab_agent"]);
  });
});
