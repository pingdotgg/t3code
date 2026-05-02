import type { DesktopServerExposureState, DesktopTailnetInfo } from "@t3tools/contracts";

export function resolveDesktopTailnetUrl(
  exposureState: DesktopServerExposureState | null,
  tailnetInfo: DesktopTailnetInfo | null,
): string | null {
  if (!exposureState || exposureState.mode !== "network-accessible") {
    return null;
  }
  if (!tailnetInfo?.connected || !tailnetInfo.hostname || !exposureState.endpointUrl) {
    return null;
  }

  try {
    const endpointUrl = new URL(exposureState.endpointUrl);
    endpointUrl.hostname = tailnetInfo.hostname;
    return endpointUrl.toString();
  } catch {
    return null;
  }
}
