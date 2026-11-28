// @effect-diagnostics globalTimers:off - Electron CDP callbacks run outside the Effect runtime.
/** Native capture remains available when an occluded guest's CDP capture stops. */
export const captureGuestPage = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const format = params["format"] ?? "png";
  if (
    Object.keys(params).some(
      (key) =>
        !["format", "quality", "optimizeForSpeed", "captureBeyondViewport", "fromSurface"].includes(
          key,
        ),
    ) ||
    params["clip"] !== undefined ||
    params["captureBeyondViewport"] === true ||
    params["fromSurface"] === false ||
    (format !== "png" && format !== "jpeg")
  ) {
    return debuggee.sendCommand("Page.captureScreenshot", params);
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const paint = async () => {
      const { frameTree } = (await debuggee.sendCommand("Page.getFrameTree")) as {
        frameTree?: { frame?: { id?: string } };
      };
      if (!frameTree?.frame?.id) throw new Error("The screenshot paint frame is unavailable.");
      const { executionContextId } = (await debuggee.sendCommand("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "t3-preview-guest-capture",
      })) as { executionContextId?: number };
      if (typeof executionContextId !== "number")
        throw new Error("The screenshot paint context is unavailable.");
      const response = (await debuggee.sendCommand("Runtime.evaluate", {
        expression:
          "new Promise(resolve => { let frame; const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, 2000); frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(true); }); }); })",
        contextId: executionContextId,
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (response.exceptionDetails || response.result?.value !== true)
        throw new Error("The screenshot paint boundary was not confirmed.");
    };
    // A native warmup wakes suspended guests; its pixels can predate the last DOM change.
    await Promise.race([
      Promise.all([paint(), webContents.capturePage(undefined, { stayHidden: true })]),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("The screenshot paint boundary timed out.")),
          2500,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  const image = await webContents.capturePage(undefined, { stayHidden: true });
  const data =
    format === "jpeg"
      ? image.toJPEG(typeof params["quality"] === "number" ? params["quality"] : 80)
      : image.toPNG();
  return { data: data.toString("base64") };
};
