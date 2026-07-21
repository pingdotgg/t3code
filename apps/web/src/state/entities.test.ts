import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  hasLocalDraft: false,
  shell: null as object | null,
  detailAtom: vi.fn((ref: ScopedThreadRef) => ({ kind: "detail", ref })),
  threadShellAtom: vi.fn((ref: ScopedThreadRef) => ({ kind: "shell", ref })),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly kind?: string }) => {
    if (atom.kind === "shell") return mocks.shell;
    if (atom.kind === "detail") return { id: "detail" };
    return null;
  },
}));

vi.mock("@t3tools/client-runtime/state/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/threads")>()),
  mergeEnvironmentThread: (detail: unknown, shell: unknown) => ({ detail, shell }),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (
    selector: (store: { getDraftThreadByRef: () => object | null }) => unknown,
  ) =>
    selector({
      getDraftThreadByRef: () => (mocks.hasLocalDraft ? {} : null),
    }),
}));

vi.mock("./threads", () => ({
  environmentThreadDetails: {
    detailAtom: mocks.detailAtom,
  },
  environmentThreadShells: {
    threadShellAtom: mocks.threadShellAtom,
  },
}));

import { shouldSubscribeToThreadDetail, useThread } from "./entities";

const THREAD_REF: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

beforeEach(() => {
  mocks.hasLocalDraft = false;
  mocks.shell = null;
  mocks.detailAtom.mockClear();
  mocks.threadShellAtom.mockClear();
});

describe("thread detail subscription", () => {
  it("waits for a server shell before subscribing for a local draft", () => {
    expect(
      shouldSubscribeToThreadDetail({
        hasLocalDraft: true,
        hasServerShell: false,
      }),
    ).toBe(false);
    expect(
      shouldSubscribeToThreadDetail({
        hasLocalDraft: true,
        hasServerShell: true,
      }),
    ).toBe(true);
  });

  it("keeps normal server thread subscriptions independent of shell state", () => {
    expect(
      shouldSubscribeToThreadDetail({
        hasLocalDraft: false,
        hasServerShell: false,
      }),
    ).toBe(true);
  });

  it("starts the actual detail hook only after a local draft receives its shell", () => {
    mocks.hasLocalDraft = true;

    function Probe() {
      useThread(THREAD_REF);
      return null;
    }

    renderToStaticMarkup(createElement(Probe));
    expect(mocks.detailAtom).not.toHaveBeenCalled();

    mocks.shell = { id: THREAD_REF.threadId };
    renderToStaticMarkup(createElement(Probe));
    expect(mocks.detailAtom).toHaveBeenCalledOnce();
    expect(mocks.detailAtom).toHaveBeenCalledWith(THREAD_REF);
  });
});
