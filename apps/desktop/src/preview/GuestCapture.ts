/** Native capture supplies unchanged frames when an occluded guest's CDP capture stops. */
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
  const image = await webContents.capturePage(undefined, { stayHidden: true });
  const data =
    format === "jpeg"
      ? image.toJPEG(typeof params["quality"] === "number" ? params["quality"] : 80)
      : image.toPNG();
  return { data: data.toString("base64") };
};
