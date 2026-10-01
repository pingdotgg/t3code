/**
 * The Browser pack's capture runner driven through this client's real
 * `t3.browser/capture` bridge — the path a header button press takes.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PreviewAnnotationSubmissionResult } from "@t3tools/contracts";
import {
  BROWSER_CAPTURE,
  BROWSER_SESSIONS,
  type BrowserCaptureHost,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiInvocation } from "@t3tools/extension-sdk/capabilities";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { createBrowserCaptureBridge, type BrowserCaptureBridgeDeps } from "./browserCaptureBridge";

type BrowserCaptureState =
  | { readonly kind: "idle" }
  | { readonly kind: "capturing"; readonly target: "page" | "element" }
  | { readonly kind: "done"; readonly message: string | null };

// The pack is not a web dependency, so this project cannot type-check its
// source; the runner is loaded by path and typed by its call shape here.
const { runBrowserCapture } = (await import(
  "../../../../packages/first-party-extensions/browser/capture.ts" as string
)) as {
  runBrowserCapture: (
    host: {
      browserCapture: BrowserCaptureHost;
      invokeApi: (request: ApiInvocation, signal: AbortSignal) => Promise<unknown>;
    },
    session: { context: typeof context; signal: AbortSignal },
    held: { tabId: string; serverEpoch: string },
    target: "page" | "element",
    isCurrent: () => boolean,
    onState: (state: BrowserCaptureState) => void,
    ackTimeoutMs: number | undefined,
    cancel: AbortSignal,
  ) => Promise<void>;
};

const context = {
  client: "desktop",
  resource: {
    namespace: "t3.browser",
    id: "view",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
} as const;
const held = { tabId: "tab-1", serverEpoch: "epoch-1" };
const RUNTIME_TAB_ID = JSON.stringify(["env-a", "thread-a", "epoch-1", "tab-1"]);
const ARTIFACT_REF = "pending-0f1e2d3c-4b5a-4968-8776-655443322110";

const picked = {
  submission: "attach",
  annotation: {
    id: "annotation-1",
    pageUrl: "http://localhost:5173/",
    pageTitle: "Home",
    comment: "",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: {
      dataUrl: "data:image/png;base64,iVBORw0KGgoHBw==",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    },
    createdAt: "2026-09-27T00:00:00.000Z",
  },
} satisfies PreviewAnnotationSubmissionResult;

/** `presented` is left to the bridge's default (the real surface store) when `realPresence`. */
function rig(overrides: Partial<BrowserCaptureBridgeDeps> = {}, realPresence = false) {
  const preview = {
    capturePageImage: vi.fn(async () => ({
      mimeType: "image/png" as const,
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      width: 1,
      height: 1,
      pageUrl: null,
      pageTitle: null,
      path: null,
    })),
    pickElement: vi.fn(async (): Promise<PreviewAnnotationSubmissionResult | null> => picked),
    cancelPickElement: vi.fn(async () => {}),
    revealArtifact: vi.fn(async (_path: string) => {}),
    copyArtifactToClipboard: vi.fn(async (_path: string) => {}),
  };
  const bridge = createBrowserCaptureBridge("env-a", {
    preview: () => preview,
    resolveThreadScope: () => ({ projectId: "project-a", authoritative: true }),
    serverEpoch: () => "epoch-1",
    ...(realPresence ? {} : { presented: () => true }),
    upload: async () => ARTIFACT_REF,
    ...overrides,
  })({
    grants: { capabilities: [BROWSER_SESSIONS, BROWSER_CAPTURE], projectIds: ["project-a"] },
    lifetime: new AbortController().signal,
  });
  const invoked: ApiInvocation[] = [];
  // Like the real host, an invoke on an aborted signal rejects.
  const invokeApi = async (request: ApiInvocation, signal: AbortSignal) => {
    invoked.push(request);
    if (signal.aborted) throw signal.reason;
    return request.method === "insertImage"
      ? { inserted: true, target: "env-a:thread-a" }
      : { notificationId: "n-1" };
  };
  const states: BrowserCaptureState[] = [];
  const cancel = new AbortController();
  const run = (target: "page" | "element") =>
    runBrowserCapture(
      { browserCapture: bridge, invokeApi },
      { context, signal: new AbortController().signal },
      held,
      target,
      () => true,
      (state) => states.push(state),
      undefined,
      cancel.signal,
    );
  return { preview, invoked, states, cancel, run };
}

describe("browser capture run through the bridge", () => {
  it("treats Cancel annotation during the upload as a silent cancel", async () => {
    let finishUpload: (ref: string) => void = () => {};
    let uploadStarted: () => void = () => {};
    const uploading = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const r = rig({
      upload: () =>
        new Promise((resolve) => {
          finishUpload = resolve;
          uploadStarted();
        }),
    });
    const running = r.run("element");
    await uploading;
    r.cancel.abort();
    finishUpload(ARTIFACT_REF);
    await running;
    // Released with nothing on the status line, no insert, and no toast.
    expect(r.states.at(-1)).toEqual({ kind: "done", message: null });
    expect(r.invoked).toEqual([]);
  });

  it("stays silent when the upload rejects after Cancel annotation", async () => {
    let failUpload: (error: Error) => void = () => {};
    let uploadStarted: () => void = () => {};
    const uploading = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const r = rig({
      upload: () =>
        new Promise((_resolve, reject) => {
          failUpload = reject;
          uploadStarted();
        }),
    });
    const running = r.run("element");
    await uploading;
    r.cancel.abort();
    failUpload(new Error("Capture upload rejected (503)."));
    await running;
    // The bridge settles as upload-failed, but no "Could not capture" toast.
    expect(r.states.at(-1)).toEqual({ kind: "done", message: null });
    expect(r.invoked).toEqual([]);
  });

  it("announces the run before the bridge is asked, so the panel can clear stale faults", async () => {
    const r = rig();
    let seenByEngine: BrowserCaptureState[] = [];
    r.preview.capturePageImage.mockImplementationOnce(async () => {
      seenByEngine = [...r.states];
      return {
        mimeType: "image/png",
        data: new Uint8Array([1]),
        width: 1,
        height: 1,
        pageUrl: null,
        pageTitle: null,
        path: null,
      };
    });
    await r.run("page");
    expect(seenByEngine).toEqual([{ kind: "capturing", target: "page" }]);
    expect(r.states.at(-1)).toEqual({ kind: "done", message: null });
  });

  describe("presentation visibility (real surface store)", () => {
    const owner = Symbol("slot");
    const present = (visible: boolean) => {
      const store = useBrowserSurfaceStore.getState();
      store.claim(RUNTIME_TAB_ID, owner, false, false);
      store.present(RUNTIME_TAB_ID, owner, { x: 0, y: 0, width: 100, height: 100 }, visible, 0, 30);
    };
    afterEach(() => useBrowserSurfaceStore.getState().release(RUNTIME_TAB_ID, owner));

    it("refuses a pick while the leased surface is hidden (clipped or occluded)", async () => {
      present(false);
      const r = rig({}, true);
      await r.run("element");
      expect(r.preview.pickElement).not.toHaveBeenCalled();
      expect(r.states.at(-1)).toMatchObject({
        kind: "done",
        message: expect.stringMatching(/^Capture failed — not-presented/),
      });
    });

    it("picks once the leased surface is on screen", async () => {
      present(true);
      const r = rig({}, true);
      await r.run("element");
      expect(r.preview.pickElement).toHaveBeenCalledOnce();
      expect(r.states.at(-1)).toEqual({ kind: "done", message: "Element capture added to chat." });
    });
  });
});
