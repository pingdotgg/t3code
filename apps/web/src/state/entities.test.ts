import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  hasLocalDraft: false,
  shell: null as object | null,
  detailAtom: vi.fn((ref: ScopedThreadRef) => ({ kind: "detail", ref })),
  statusAtom: vi.fn((ref: ScopedThreadRef) => ({ kind: "status", ref })),
  threadShellAtom: vi.fn((ref: ScopedThreadRef) => ({ kind: "shell", ref })),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly kind?: string }) => {
    if (atom.kind === "shell") return mocks.shell;
    if (atom.kind === "detail") return { id: "detail" };
    if (atom.kind === "status") return "deleted";
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
    statusAtom: mocks.statusAtom,
  },
  environmentThreadShells: {
    threadShellAtom: mocks.threadShellAtom,
  },
}));

import {
  classifyThreadDetail,
  resolveThreadDetailRef,
  useThread,
  useThreadDetailWhenReady,
  useThreadStatusWhenReady,
} from "./entities";

const THREAD_REF: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

beforeEach(() => {
  mocks.hasLocalDraft = false;
  mocks.shell = null;
  mocks.detailAtom.mockClear();
  mocks.statusAtom.mockClear();
  mocks.threadShellAtom.mockClear();
});

describe("thread detail subscription", () => {
  it("starts the actual detail hook immediately for an ordinary thread", () => {
    function Probe() {
      useThread(THREAD_REF);
      return null;
    }

    renderToStaticMarkup(createElement(Probe));
    expect(mocks.detailAtom).toHaveBeenCalledOnce();
    expect(mocks.detailAtom).toHaveBeenCalledWith(THREAD_REF);
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

  it("preserves explicit shell gating for callers without a local draft", () => {
    function Probe() {
      useThread(THREAD_REF, { waitForShell: true });
      return null;
    }

    renderToStaticMarkup(createElement(Probe));
    expect(mocks.detailAtom).not.toHaveBeenCalled();

    mocks.shell = { id: THREAD_REF.threadId };
    renderToStaticMarkup(createElement(Probe));
    expect(mocks.detailAtom).toHaveBeenCalledOnce();
    expect(mocks.detailAtom).toHaveBeenCalledWith(THREAD_REF);
  });

  it("gates direct detail state consumers until a local draft receives its shell", () => {
    function Probe({ hasServerShell }: { readonly hasServerShell: boolean }) {
      const classification = classifyThreadDetail({
        hasLocalDraft: true,
        hasServerShell,
      });
      useThreadDetailWhenReady(THREAD_REF, classification);
      useThreadStatusWhenReady(THREAD_REF, classification);
      return null;
    }

    renderToStaticMarkup(createElement(Probe, { hasServerShell: false }));
    expect(mocks.detailAtom).not.toHaveBeenCalled();
    expect(mocks.statusAtom).not.toHaveBeenCalled();

    renderToStaticMarkup(createElement(Probe, { hasServerShell: true }));
    expect(mocks.detailAtom).toHaveBeenCalledOnce();
    expect(mocks.detailAtom).toHaveBeenCalledWith(THREAD_REF);
    expect(mocks.statusAtom).toHaveBeenCalledOnce();
    expect(mocks.statusAtom).toHaveBeenCalledWith(THREAD_REF);
  });
});

describe("resolveThreadDetailRef", () => {
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(
        THREAD_REF,
        classifyThreadDetail({
          hasLocalDraft: true,
          hasServerShell: false,
        }),
      ),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(
        THREAD_REF,
        classifyThreadDetail({
          hasLocalDraft: true,
          hasServerShell: true,
        }),
      ),
    ).toBe(THREAD_REF);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(
        THREAD_REF,
        classifyThreadDetail({
          hasLocalDraft: false,
          hasServerShell: false,
        }),
      ),
    ).toBe(THREAD_REF);
  });

  it("maps explicit shell-gating callers through the same draft classification", () => {
    expect(
      resolveThreadDetailRef(
        THREAD_REF,
        classifyThreadDetail({
          hasLocalDraft: false,
          hasServerShell: false,
          waitForShell: true,
        }),
      ),
    ).toBeNull();
  });
});
