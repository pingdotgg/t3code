/** Select the native Wayland backend for graphical Linux hosts, preserving explicit opt-outs. */
export function cuaDriverHostOptions(
  binaryPath: string,
  hostBundleId: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
) {
  const wayland = platform === "linux" && Boolean(environment.WAYLAND_DISPLAY?.trim());
  return {
    binaryPath,
    hostBundleId,
    approveCapabilityManifest: false,
    approveSessionPolicy: false,
    dangerouslyBypassApprovals: false,
    inheritStderr: true,
    noOverlay: false,
    environment: wayland
      ? [
          {
            name: "CUA_DRIVER_RS_ENABLE_WAYLAND",
            value: environment.CUA_DRIVER_RS_ENABLE_WAYLAND ?? "1",
          },
        ]
      : [],
  };
}
