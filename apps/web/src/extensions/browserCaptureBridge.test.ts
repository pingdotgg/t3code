import { describe, it, expect, vi } from "vite-plus/test";
import type {
  DesktopPreviewPageImage,
  PreviewAnnotationSubmissionResult,
} from "@t3tools/contracts";
import { BROWSER_CAPTURE, BROWSER_SESSIONS } from "@t3tools/extension-sdk/catalogue";

import {
  createBrowserCaptureBridge,
  type BrowserCaptureBinding,
  type BrowserCaptureBridgeDeps,
} from "./browserCaptureBridge";
import { readBrowserCaptureAnnotation } from "./browserCaptureAnnotations";

const context = {
  client: "desktop",
  resource: {
    namespace: "test.plugin",
    id: "view",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
};
const session = { tabId: "tab-1", serverEpoch: "epoch-1" };
const ARTIFACT_REF = "pending-0f1e2d3c-4b5a-4968-8776-655443322110";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
// "iVBORw0KGgoHBw==" is PNG above, as the picker's data URL carries it.
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoHBw==";
const SAVED_PATH = "/home/u/.t3/browser-artifacts/browser-screenshot-localhost-1.png";

function pick(overrides: Partial<PreviewAnnotationSubmissionResult["annotation"]> = {}) {
  return {
    submission: "attach",
    annotation: {
      id: "annotation-1",
      pageUrl: "http://localhost:5173/settings",
      pageTitle: "Settings",
      comment: "make this blue",
      elements: [
        {
          id: "el-1",
          rect: { x: 0, y: 0, width: 10, height: 10 },
          element: {
            pageUrl: "http://localhost:5173/settings",
            pageTitle: "Settings",
            tagName: "button",
            selector: "#save",
            htmlPreview: "<button id=save>Save</button>",
            componentName: "SaveButton",
            source: {
              functionName: null,
              fileName: "src/Save.tsx",
              lineNumber: 12,
              columnNumber: 4,
            },
            stack: [],
            styles: "color: red",
            pickedAt: "2026-09-26T00:00:00.000Z",
          },
        },
      ],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: {
        dataUrl: PNG_DATA_URL,
        width: 120,
        height: 40,
        cropRect: { x: 0, y: 0, width: 120, height: 40 },
      },
      createdAt: "2026-09-26T00:00:00.000Z",
      ...overrides,
    },
  } satisfies PreviewAnnotationSubmissionResult;
}

function harness(overrides: Partial<BrowserCaptureBridgeDeps> = {}) {
  const uploads: { environmentId: string; bytes: Uint8Array; type: string; name: string }[] = [];
  const preview = {
    capturePageImage: vi.fn(async (): Promise<DesktopPreviewPageImage> => ({
      mimeType: "image/png",
      data: PNG,
      width: 1280,
      height: 800,
      pageUrl: "http://localhost:5173/",
      pageTitle: "Home",
      path: SAVED_PATH,
    })),
    pickElement: vi.fn(async (): Promise<PreviewAnnotationSubmissionResult | null> => pick()),
    cancelPickElement: vi.fn(async () => {}),
    revealArtifact: vi.fn(async (_path: string) => {}),
    copyArtifactToClipboard: vi.fn(async (_path: string) => {}),
  };
  const clipboardText: string[] = [];
  const deps: Partial<BrowserCaptureBridgeDeps> = {
    preview: () => preview,
    resolveThreadScope: () => ({ projectId: "project-a", authoritative: true }),
    serverEpoch: () => "epoch-1",
    presented: () => true,
    upload: async (environmentId, png, name) => {
      uploads.push({
        environmentId,
        bytes: new Uint8Array(await png.arrayBuffer()),
        type: png.type,
        name,
      });
      return ARTIFACT_REF;
    },
    writeClipboardText: async (text) => {
      clipboardText.push(text);
    },
    platform: () => "MacIntel",
    ...overrides,
  };
  const lifetime = new AbortController();
  const bind = createBrowserCaptureBridge("env-a", deps);
  const host = (grants: Partial<BrowserCaptureBinding["grants"]> = {}, installationId?: string) =>
    bind({
      ...(installationId ? { installationId } : {}),
      grants: {
        capabilities: [BROWSER_SESSIONS, BROWSER_CAPTURE, "t3.browser/artifact-actions"],
        projectIds: ["project-a"],
        ...grants,
      },
      lifetime: lifetime.signal,
    });
  return { host, preview, uploads, lifetime, clipboardText };
}

describe("browser capture bridge", () => {
  it("refuses annotation without composer access before opening the picker", async () => {
    const h = harness();
    const result = await h
      .host({}, "ext.a")
      .capture({ context, session, target: "element", annotation: true });
    expect(result).toMatchObject({ ok: false, failure: { reason: "grant-denied" } });
    expect(h.preview.pickElement).not.toHaveBeenCalled();
  });
  it("does not retain an annotation handle for ordinary element screenshots", async () => {
    const h = harness();
    const result = await h.host({}, "ext.a").capture({ context, session, target: "element" });
    expect(result.ok).toBe(true);
    expect(result.annotationRef).toBeUndefined();
    expect(h.uploads).toHaveLength(1);
    h.lifetime.abort();
  });
  it("retains annotation crops locally without waiting for an unused upload", async () => {
    const fixture = harness();
    const host = fixture.host(
      { capabilities: [BROWSER_SESSIONS, BROWSER_CAPTURE, "t3.composer/write"] },
      "ext.a",
    );
    const result = await host.capture({ context, session, target: "element", annotation: true });
    expect(result.ok).toBe(true);
    expect(result.annotationRef).toBeTruthy();
    expect(fixture.uploads).toHaveLength(0);
    fixture.lifetime.abort();
  });
  it("retains native annotation geometry behind a local reference, even when the crop fails", async () => {
    const regions = [{ id: "region-a", rect: { x: 4, y: 5, width: 6, height: 7 } }];
    const h = harness();
    h.preview.pickElement.mockResolvedValue({
      ...pick({ screenshot: null, regions }),
      screenshotFailed: true,
    });
    const result = await h
      .host({ capabilities: [BROWSER_SESSIONS, BROWSER_CAPTURE, "t3.composer/write"] }, "ext.a")
      .capture({ context, session, target: "element", annotation: true });
    expect(result.ok).toBe(true);
    expect(result.annotationRef).toMatch(/^preview-annotation-/);
    const retained = readBrowserCaptureAnnotation(
      "env-a",
      "thread-a",
      "ext.a",
      result.annotationRef!,
    );
    expect(retained?.annotation.regions).toEqual(regions);
    expect(retained?.annotation.elements[0]?.element.htmlPreview).toContain("<button");
    expect(retained?.screenshotFailed).toBe(true);
    expect(h.uploads).toHaveLength(0);
    expect(JSON.stringify(result)).not.toMatch(/base64|htmlPreview|region-a/);
    h.lifetime.abort();
    expect(
      readBrowserCaptureAnnotation("env-a", "thread-a", "ext.a", result.annotationRef!),
    ).toBeNull();
  });

  it("retains the crop locally without an uploaded artifact", async () => {
    const h = harness();
    const result = await h
      .host({ capabilities: [BROWSER_SESSIONS, BROWSER_CAPTURE, "t3.composer/write"] }, "ext.a")
      .capture({ context, session, target: "element", annotation: true });
    expect(result.ok).toBe(true);
    const retained = readBrowserCaptureAnnotation(
      "env-a",
      "thread-a",
      "ext.a",
      result.annotationRef!,
    );
    expect(retained?.file?.size).toBe(PNG.byteLength);
    expect(retained?.artifactRef).toBeNull();
    expect(h.uploads).toHaveLength(0);
    expect(retained?.screenshotFailed).toBe(false);
    h.lifetime.abort();
  });
  it("drops a leftover crop when the native picker reports screenshot failure", async () => {
    const h = harness();
    h.preview.pickElement.mockResolvedValue({ ...pick(), screenshotFailed: true });
    const result = await h
      .host({ capabilities: [BROWSER_SESSIONS, BROWSER_CAPTURE, "t3.composer/write"] }, "ext.a")
      .capture({ context, session, target: "element", annotation: true });
    expect(result.ok).toBe(true);
    const retained = readBrowserCaptureAnnotation(
      "env-a",
      "thread-a",
      "ext.a",
      result.annotationRef!,
    );
    expect(retained?.file).toBeNull();
    expect(retained?.annotation.screenshot).toBeNull();
    expect(retained?.screenshotFailed).toBe(true);
    h.lifetime.abort();
  });
  it("preserves the 1.1.0 screenshot actions with only the original grants", async () => {
    const fixture = harness();
    const host = fixture.host({ capabilities: [BROWSER_SESSIONS, BROWSER_CAPTURE] });
    const result = await host.capture({ context, session, target: "page" });
    expect(result.ok).toBe(true);
    expect(host.artifactActions).toMatchObject({
      copyImage: { supported: true },
      copyPath: { supported: true },
      reveal: { supported: true },
    });
    for (const action of [
      host.revealArtifact!,
      host.copyArtifactPath!,
      host.copyArtifactToClipboard!,
    ]) {
      expect(await action({ context, artifactRef: ARTIFACT_REF })).toEqual({ ok: true });
    }
  });

  it("captures the page into the store and hands back only an artifactRef", async () => {
    const h = harness();
    const result = await h.host().capture({ context, session, target: "page" });
    expect(result).toEqual({
      ok: true,
      artifact: {
        artifactRef: ARTIFACT_REF,
        mimeType: "image/png",
        sizeBytes: PNG.byteLength,
        width: 1280,
        height: 800,
        target: "page",
        pageUrl: "http://localhost:5173/",
        pageTitle: "Home",
        saved: true,
      },
    });
    // The desktop tab id is the runtime identity, never the public tabId alone.
    expect(h.preview.capturePageImage).toHaveBeenCalledWith(
      JSON.stringify(["env-a", "thread-a", "epoch-1", "tab-1"]),
    );
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0]).toMatchObject({ environmentId: "env-a", type: "image/png" });
    expect([...h.uploads[0]!.bytes]).toEqual([...PNG]);
    expect(JSON.stringify(result)).not.toMatch(/base64|iVBORw/);
  });

  it("keeps a picked element's crop and summary, but not its data URL", async () => {
    const h = harness();
    const result = await h.host().capture({ context, session, target: "element" });
    if (!result.ok) throw new Error(result.failure.detail);
    expect(result.artifact).toMatchObject({
      artifactRef: ARTIFACT_REF,
      target: "element",
      width: 120,
      height: 40,
      pageUrl: "http://localhost:5173/settings",
      comment: "make this blue",
      elements: [
        {
          tagName: "button",
          selector: "#save",
          componentName: "SaveButton",
          source: { fileName: "src/Save.tsx", lineNumber: 12, columnNumber: 4 },
        },
      ],
    });
    expect([...h.uploads[0]!.bytes]).toEqual([...PNG]);
    expect(JSON.stringify(result)).not.toMatch(/base64|iVBORw|htmlPreview/);
  });

  it("names the missing grant and never touches the engine", async () => {
    const h = harness();
    const result = await h
      .host({ capabilities: [BROWSER_SESSIONS] })
      .capture({ context, session, target: "page" });
    expect(result).toMatchObject({
      ok: false,
      failure: { reason: "grant-denied", grant: BROWSER_CAPTURE },
    });
    expect(h.preview.capturePageImage).not.toHaveBeenCalled();
  });

  it("reports desktop-required, not-presented, and epoch-changed by name", async () => {
    const web = harness({ preview: () => null });
    expect(web.host().support).toEqual({ supported: false, reason: "desktop-required" });
    expect(await web.host().capture({ context, session, target: "page" })).toMatchObject({
      failure: { reason: "desktop-required" },
    });
    const hidden = harness({ presented: () => false });
    expect(await hidden.host().capture({ context, session, target: "page" })).toMatchObject({
      failure: { reason: "not-presented" },
    });
    const moved = harness({ serverEpoch: () => "epoch-2" });
    expect(await moved.host().capture({ context, session, target: "page" })).toMatchObject({
      failure: { reason: "epoch-changed" },
    });
    const foreign = harness();
    expect(
      await foreign
        .host({ projectIds: ["project-b"] })
        .capture({ context, session, target: "page" }),
    ).toMatchObject({ failure: { reason: "scope-invalid" } });
  });

  it("treats a dismissed or crop-less pick as named outcomes, never a fake image", async () => {
    const dismissed = harness();
    dismissed.preview.pickElement.mockResolvedValueOnce(null);
    expect(await dismissed.host().capture({ context, session, target: "element" })).toMatchObject({
      failure: { reason: "cancelled" },
    });
    const cropless = harness();
    cropless.preview.pickElement.mockResolvedValueOnce(pick({ screenshot: null }));
    expect(await cropless.host().capture({ context, session, target: "element" })).toMatchObject({
      failure: { reason: "capture-failed" },
    });
    expect(dismissed.uploads).toHaveLength(0);
    expect(cropless.uploads).toHaveLength(0);
  });

  it("treats a picker that throws as a dismissal, keeping capture-failed for a lost crop", async () => {
    const h = harness();
    h.preview.pickElement.mockRejectedValueOnce(new Error("guest navigated"));
    expect(await h.host().capture({ context, session, target: "element" })).toMatchObject({
      ok: false,
      failure: { reason: "cancelled", detail: "guest navigated" },
    });
    const undecodable = harness();
    undecodable.preview.pickElement.mockResolvedValueOnce(
      pick({
        screenshot: {
          dataUrl: "data:image/png;base64,@@@",
          width: 10,
          height: 10,
          cropRect: { x: 0, y: 0, width: 10, height: 10 },
        },
      }),
    );
    expect(await undecodable.host().capture({ context, session, target: "element" })).toMatchObject(
      { failure: { reason: "capture-failed" } },
    );
    expect(h.uploads).toHaveLength(0);
    expect(undecodable.uploads).toHaveLength(0);
  });

  it("cancels the open picker when the caller aborts", async () => {
    const h = harness();
    let resolvePick: (value: PreviewAnnotationSubmissionResult | null) => void = () => {};
    h.preview.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePick = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = h.host().capture({
      context,
      session,
      target: "element",
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    expect(h.preview.cancelPickElement).toHaveBeenCalledOnce();
    resolvePick(null);
    expect(await pending).toMatchObject({ failure: { reason: "cancelled" } });
  });

  it("stores nothing when the caller aborts while the page rasterizes", async () => {
    const h = harness();
    let release: () => void = () => {};
    h.preview.capturePageImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              mimeType: "image/png",
              data: PNG,
              width: 1,
              height: 1,
              pageUrl: null,
              pageTitle: null,
              path: null,
            });
        }),
    );
    const controller = new AbortController();
    const pending = h.host().capture({
      context,
      session,
      target: "page",
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    release();
    expect(await pending).toMatchObject({ failure: { reason: "cancelled" } });
    expect(h.uploads).toHaveLength(0);
  });

  it("refuses a second capture of the same session while one runs", async () => {
    const h = harness();
    let release: () => void = () => {};
    h.preview.capturePageImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              mimeType: "image/png",
              data: PNG,
              width: 1,
              height: 1,
              pageUrl: null,
              pageTitle: null,
              path: null,
            });
        }),
    );
    const first = h.host().capture({ context, session, target: "page" });
    await Promise.resolve();
    expect(await h.host().capture({ context, session, target: "page" })).toMatchObject({
      failure: { reason: "busy" },
    });
    release();
    expect(await first).toMatchObject({ ok: true });
  });

  it("maps engine and store failures to named reasons", async () => {
    const engine = harness();
    engine.preview.capturePageImage.mockRejectedValueOnce(new Error("UnknownVizError"));
    expect(await engine.host().capture({ context, session, target: "page" })).toMatchObject({
      failure: { reason: "capture-failed", detail: "UnknownVizError" },
    });
    const store = harness({
      upload: async () => {
        throw new Error("Capture upload rejected (413).");
      },
    });
    expect(await store.host().capture({ context, session, target: "page" })).toMatchObject({
      failure: { reason: "upload-failed", detail: "Capture upload rejected (413)." },
    });
  });

  describe("artifact actions", () => {
    const request = { context, artifactRef: ARTIFACT_REF };

    it("does not require a new grant for saved screenshot actions", async () => {
      const h = harness();
      const host = h.host({ capabilities: [BROWSER_SESSIONS, BROWSER_CAPTURE] });
      expect(await host.capture({ context, session, target: "page" })).toMatchObject({ ok: true });
      expect(await host.revealArtifact!(request)).toEqual({ ok: true });
      expect(await host.copyArtifactToClipboard!(request)).toEqual({ ok: true });
      expect(await host.copyArtifactPath!(request)).toEqual({ ok: true });
      expect(host.artifactActions?.reveal.supported).toBe(true);
      expect(h.preview.revealArtifact).toHaveBeenCalledWith(SAVED_PATH);
      expect(h.preview.copyArtifactToClipboard).toHaveBeenCalledWith(SAVED_PATH);
      expect(h.clipboardText).toEqual([SAVED_PATH]);
    });

    it("acts on the file its own page capture saved, through the desktop bridge", async () => {
      const h = harness();
      const host = h.host();
      expect(host.artifactActions).toEqual({
        copyImage: { supported: true },
        copyPath: { supported: true },
        reveal: { supported: true },
        revealLabel: "Reveal in Finder",
      });
      // Nothing saved yet: the ref is unknown rather than guessed at.
      expect(await host.revealArtifact!(request)).toMatchObject({
        ok: false,
        failure: { reason: "artifact-not-found" },
      });
      await host.capture({ context, session, target: "page" });
      expect(await host.copyArtifactToClipboard!(request)).toEqual({ ok: true });
      expect(await host.copyArtifactPath!(request)).toEqual({ ok: true });
      expect(await host.revealArtifact!(request)).toEqual({ ok: true });
      expect(h.preview.copyArtifactToClipboard).toHaveBeenCalledWith(SAVED_PATH);
      expect(h.preview.revealArtifact).toHaveBeenCalledWith(SAVED_PATH);
      expect(h.clipboardText).toEqual([SAVED_PATH]);
    });

    it("keeps one installation's saved captures from another", async () => {
      const h = harness();
      await h.host().capture({ context, session, target: "page" });
      expect(await h.host().revealArtifact!(request)).toMatchObject({
        ok: false,
        failure: { reason: "artifact-not-found" },
      });
      expect(h.preview.revealArtifact).not.toHaveBeenCalled();
    });

    it("authorizes by the capture grants and the granted project", async () => {
      const h = harness();
      const host = h.host();
      await host.capture({ context, session, target: "page" });
      expect(
        await h.host({ capabilities: [BROWSER_SESSIONS] }).copyArtifactPath!(request),
      ).toMatchObject({ ok: false, failure: { reason: "grant-denied", grant: BROWSER_CAPTURE } });
      const foreign = { ...context, resource: { ...context.resource, projectId: "project-b" } };
      expect(await host.copyArtifactPath!({ ...request, context: foreign })).toMatchObject({
        ok: false,
        failure: { reason: "scope-invalid" },
      });
      expect(h.clipboardText).toEqual([]);
    });

    it("reports element picks and unsaved pages as having no saved file", async () => {
      const h = harness();
      const host = h.host();
      await host.capture({ context, session, target: "element" });
      expect(await host.copyArtifactToClipboard!(request)).toMatchObject({
        ok: false,
        failure: { reason: "artifact-not-found" },
      });
      h.preview.capturePageImage.mockResolvedValueOnce({
        mimeType: "image/png",
        data: PNG,
        width: 1,
        height: 1,
        pageUrl: null,
        pageTitle: null,
        path: null,
      });
      await host.capture({ context, session, target: "page" });
      expect(await host.revealArtifact!(request)).toMatchObject({
        ok: false,
        failure: { reason: "artifact-not-found" },
      });
    });

    it("names a refused OS action without leaking the saved path", async () => {
      const h = harness();
      const host = h.host();
      await host.capture({ context, session, target: "page" });
      const leak = new Error(`Preview artifact could not be loaded as an image: ${SAVED_PATH}`);
      h.preview.copyArtifactToClipboard.mockRejectedValueOnce(leak);
      h.preview.revealArtifact.mockRejectedValueOnce(leak);
      const failures = [
        await host.copyArtifactToClipboard!(request),
        await host.revealArtifact!(request),
        await h.host().copyArtifactPath!(request),
      ];
      const bridge = harness({
        writeClipboardText: async () => {
          throw leak;
        },
      });
      const other = bridge.host();
      await other.capture({ context, session, target: "page" });
      failures.push(await other.copyArtifactPath!(request));
      expect(failures.map((result) => !result.ok && result.failure.reason)).toEqual([
        "action-failed",
        "action-failed",
        "artifact-not-found",
        "action-failed",
      ]);
      const serialized = JSON.stringify(failures);
      expect(serialized).not.toContain(SAVED_PATH);
      expect(serialized).not.toContain("browser-artifacts");
    });

    it("binds a saved capture to the project it was taken in", async () => {
      const h = harness();
      const host = h.host({ projectIds: ["project-a", "project-b"] });
      await host.capture({ context, session, target: "page" });
      const projectB = {
        ...context,
        resource: { ...context.resource, projectId: "project-b", threadId: "thread-b" },
      };
      expect(await host.copyArtifactPath!({ ...request, context: projectB })).toMatchObject({
        ok: false,
        failure: { reason: "artifact-not-found" },
      });
      expect(h.clipboardText).toEqual([]);
      expect(await host.copyArtifactPath!(request)).toEqual({ ok: true });
    });

    it("marks which captures the artifact actions can act on", async () => {
      const h = harness();
      const host = h.host();
      const page = await host.capture({ context, session, target: "page" });
      expect(page).toMatchObject({ ok: true, artifact: { saved: true } });
      h.preview.capturePageImage.mockResolvedValueOnce({
        mimeType: "image/png",
        data: PNG,
        width: 1,
        height: 1,
        pageUrl: null,
        pageTitle: null,
        path: null,
      });
      expect(await host.capture({ context, session, target: "page" })).toMatchObject({
        ok: true,
        artifact: { saved: false },
      });
      expect(await host.capture({ context, session, target: "element" })).toMatchObject({
        ok: true,
        artifact: { saved: false },
      });
    });

    it("reports every action as desktop-only on a client without the engine", async () => {
      const h = harness({ preview: () => null });
      const host = h.host();
      expect(host.artifactActions?.reveal).toEqual({
        supported: false,
        reason: "desktop-required",
      });
      expect(await host.copyArtifactPath!(request)).toMatchObject({
        ok: false,
        failure: { reason: "desktop-required" },
      });
    });
  });
});
