import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildExternalViewIntent,
  createExternalOpenController,
  isNoHandlerLaunchError,
  sanitizeHandoffFileName,
  type ExternalOpenStatus,
} from "./workspace-file-external-open";

function createHarness(overrides?: {
  readonly requestAssetUrl?: () => Promise<string>;
  readonly downloadHandoffFile?: (
    url: string,
    fileName: string,
    signal: AbortSignal,
  ) => Promise<{ contentUri: string }>;
  readonly launchViewer?: (launch: { contentUri: string; mimeType: string }) => Promise<unknown>;
}) {
  const statuses: ExternalOpenStatus[] = [];
  const requestAssetUrl = vi.fn(
    overrides?.requestAssetUrl ??
      (() => Promise.resolve("https://server/api/assets/tok/scene.glb")),
  );
  const downloadHandoffFile = vi.fn(
    overrides?.downloadHandoffFile ??
      (() => Promise.resolve({ contentUri: "content://t3.provider/handoff/scene.glb" })),
  );
  const launchViewer = vi.fn(overrides?.launchViewer ?? (() => Promise.resolve({ resultCode: 0 })));
  const controller = createExternalOpenController({
    fileName: "scene.glb",
    mimeType: "model/gltf-binary",
    downloadHandoffFile,
    launchViewer,
    onStatusChange: (status) => statuses.push(status),
  });
  return {
    controller,
    open: () => controller.open(requestAssetUrl),
    downloadHandoffFile,
    launchViewer,
    requestAssetUrl,
    statuses,
  };
}

describe("createExternalOpenController", () => {
  it("clears preparation when the handoff launches, not when the viewer returns", async () => {
    const { open, launchViewer, statuses } = createHarness({
      // The external activity has not returned yet; the promise stays pending.
      launchViewer: () => new Promise(() => {}),
    });

    await open();

    expect(statuses).toEqual([{ _tag: "preparing" }, { _tag: "idle" }]);
    expect(launchViewer).toHaveBeenCalledWith({
      contentUri: "content://t3.provider/handoff/scene.glb",
      mimeType: "model/gltf-binary",
    });
  });

  it("hands the launcher the local content URI, never the signed remote URL", async () => {
    const { open, downloadHandoffFile, launchViewer } = createHarness();

    await open();

    expect(downloadHandoffFile).toHaveBeenCalledWith(
      "https://server/api/assets/tok/scene.glb",
      "scene.glb",
      expect.any(AbortSignal),
    );
    const launchInput = JSON.stringify(launchViewer.mock.calls[0]);
    expect(launchInput).not.toContain("https://");
    expect(launchInput).toContain("content://");
  });

  it("surfaces an asset failure as a finite error and re-requests on retry", async () => {
    const requestAssetUrl = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("The file is too large to open in another app."))
      .mockResolvedValueOnce("https://server/api/assets/tok2/scene.glb");
    const { open, downloadHandoffFile, statuses } = createHarness({ requestAssetUrl });

    await open();
    expect(statuses.at(-1)).toEqual({
      _tag: "error",
      detail: "The file is too large to open in another app.",
    });

    await open();
    expect(requestAssetUrl).toHaveBeenCalledTimes(2);
    // The retry downloads from the fresh grant, not the failed attempt's URL.
    expect(downloadHandoffFile).toHaveBeenCalledWith(
      "https://server/api/assets/tok2/scene.glb",
      "scene.glb",
      expect.any(AbortSignal),
    );
    expect(statuses.at(-1)).toEqual({ _tag: "idle" });
  });

  it("surfaces a download failure as a finite error state", async () => {
    const { open, launchViewer, statuses } = createHarness({
      downloadHandoffFile: () => Promise.reject(new Error("Network request failed")),
    });

    await open();

    expect(statuses.at(-1)).toEqual({ _tag: "error", detail: "Network request failed" });
    expect(launchViewer).not.toHaveBeenCalled();
  });

  it("maps a missing Android handler to the no-handler state", async () => {
    const { open, statuses } = createHarness({
      launchViewer: () =>
        Promise.reject(
          new Error("No Activity found to handle Intent { act=android.intent.action.VIEW }"),
        ),
    });

    await open();
    await Promise.resolve();

    expect(statuses).toEqual([{ _tag: "preparing" }, { _tag: "idle" }, { _tag: "no-handler" }]);
  });

  it("maps other launch rejections to a finite launch error", async () => {
    const { open, statuses } = createHarness({
      launchViewer: () => Promise.reject(new Error("Security exception")),
    });

    await open();
    await Promise.resolve();

    expect(statuses.at(-1)).toEqual({ _tag: "error", detail: "Security exception" });
  });

  it("ignores presses while a preparation is in flight", async () => {
    let resolveUrl: (url: string) => void = () => {};
    const { open, requestAssetUrl } = createHarness({
      requestAssetUrl: () => new Promise((resolve) => (resolveUrl = resolve)),
    });

    const first = open();
    const second = open();
    resolveUrl("https://server/api/assets/tok/scene.glb");
    await Promise.all([first, second]);

    expect(requestAssetUrl).toHaveBeenCalledTimes(1);
  });

  it("ignores presses while the external viewer is still up, then allows a reopen", async () => {
    let resolveLaunch: (value: unknown) => void = () => {};
    const launchViewer = vi
      .fn<() => Promise<unknown>>()
      .mockImplementation(() => new Promise((resolve) => (resolveLaunch = resolve)));
    const { open, downloadHandoffFile } = createHarness({ launchViewer });

    await open();
    // The launcher is single-flight until the activity returns; extra presses
    // must not re-download or delete the file the viewer is reading.
    await open();
    expect(downloadHandoffFile).toHaveBeenCalledTimes(1);

    resolveLaunch({ resultCode: 0 });
    await Promise.resolve();
    await open();
    expect(downloadHandoffFile).toHaveBeenCalledTimes(2);
  });

  it("never starts the download when disposed while the mint is pending", async () => {
    let resolveUrl: (url: string) => void = () => {};
    const { controller, downloadHandoffFile, launchViewer, open, statuses } = createHarness({
      requestAssetUrl: () => new Promise((resolve) => (resolveUrl = resolve)),
    });

    const opening = open();
    controller.dispose();
    resolveUrl("https://server/api/assets/tok/scene.glb");
    await opening;

    expect(downloadHandoffFile).not.toHaveBeenCalled();
    expect(launchViewer).not.toHaveBeenCalled();
    expect(statuses).toEqual([{ _tag: "preparing" }]);
  });

  it("aborts an in-flight download and never launches after dispose", async () => {
    let seenSignal: AbortSignal | null = null;
    let started: () => void = () => {};
    const downloadStarted = new Promise<void>((resolve) => (started = resolve));
    const { controller, launchViewer, open, statuses } = createHarness({
      downloadHandoffFile: (_url, _fileName, signal) =>
        new Promise((_, reject) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("Aborted")));
          started();
        }),
    });

    const opening = open();
    await downloadStarted;
    controller.dispose();
    await opening;

    expect(seenSignal!.aborted).toBe(true);
    expect(launchViewer).not.toHaveBeenCalled();
    // The screen is gone; the abort surfaces no error state.
    expect(statuses).toEqual([{ _tag: "preparing" }]);
  });
});

describe("buildExternalViewIntent", () => {
  it("targets ACTION_VIEW with the MIME type and a read grant", () => {
    expect(
      buildExternalViewIntent({
        contentUri: "content://t3.provider/handoff/scene.glb",
        mimeType: "model/gltf-binary",
      }),
    ).toEqual({
      action: "android.intent.action.VIEW",
      params: {
        data: "content://t3.provider/handoff/scene.glb",
        type: "model/gltf-binary",
        // Intent.FLAG_GRANT_READ_URI_PERMISSION
        flags: 1,
      },
    });
  });
});

describe("sanitizeHandoffFileName", () => {
  it.each([
    ["scene.glb", "scene.glb"],
    ["models/robot arm.glb", "robot arm.glb"],
    ["..\\evil.glb", "evil.glb"],
    ["we?ird*chars.glb", "we_ird_chars.glb"],
    ["モデル.glb", "モデル.glb"],
    ["modèle café.glb", "modèle café.glb"],
    // Hidden files with a real name pass the extension gate; the handoff
    // file must not stay hidden.
    [".hidden.glb", "hidden.glb"],
  ])("sanitizes %j to %j", (input, expected) => {
    expect(sanitizeHandoffFileName(input)).toBe(expected);
  });
});

describe("isNoHandlerLaunchError", () => {
  it("recognizes the platform ActivityNotFoundException message", () => {
    expect(
      isNoHandlerLaunchError(new Error("No Activity found to handle Intent { act=VIEW }")),
    ).toBe(true);
    expect(isNoHandlerLaunchError(new Error("Security exception"))).toBe(false);
    expect(isNoHandlerLaunchError("boom")).toBe(false);
  });
});
