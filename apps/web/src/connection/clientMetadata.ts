import type {
  AuthClientMetadataDeviceType,
  AuthClientPresentationMetadata,
  ClientOs,
  DesktopBridge,
} from "@t3tools/contracts";

interface BrowserIdentity {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
}

function clientOsFromElectronPlatform(platform: string | undefined): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform ? "other" : "unknown";
  }
}

function isIpadosDesktopUserAgent(identity: BrowserIdentity): boolean {
  return (
    /macintosh/i.test(identity.userAgent) &&
    /mac/i.test(identity.platform) &&
    identity.maxTouchPoints > 1
  );
}

export function browserClientOs(identity: BrowserIdentity): ClientOs {
  const userAgent = identity.userAgent;
  if (userAgent.trim() === "") return "unknown";
  if (/iphone|ipad|ipod/i.test(userAgent) || isIpadosDesktopUserAgent(identity)) return "iOS";
  if (/android/i.test(userAgent)) return "Android";
  if (/cros/i.test(userAgent)) return "ChromeOS";
  if (/windows/i.test(userAgent)) return "Windows";
  if (/macintosh|mac os x/i.test(userAgent)) return "macOS";
  if (/linux|x11/i.test(userAgent)) return "Linux";
  return "other";
}

export function browserFamily(userAgent: string): string {
  if (userAgent.trim() === "") return "unknown";
  if (/edg(?:e|a|ios)?\//i.test(userAgent)) return "Edge";
  if (/opr\/|opios\//i.test(userAgent)) return "Opera";
  if (/samsungbrowser\//i.test(userAgent)) return "Samsung Internet";
  if (/firefox\/|fxios\//i.test(userAgent)) return "Firefox";
  if (/chrome\/|crios\//i.test(userAgent)) return "Chrome";
  if (/safari\//i.test(userAgent)) return "Safari";
  return "other";
}

export function browserDeviceType(identity: BrowserIdentity): AuthClientMetadataDeviceType {
  const userAgent = identity.userAgent;
  if (userAgent.trim() === "") return "unknown";
  if (
    /ipad|tablet|kindle|silk/i.test(userAgent) ||
    (/android/i.test(userAgent) && !/mobile/i.test(userAgent)) ||
    isIpadosDesktopUserAgent(identity)
  ) {
    return "tablet";
  }
  if (/iphone|ipod|android.+mobile|mobile/i.test(userAgent)) return "mobile";
  return "desktop";
}

export function clientPresentationMetadata(input: {
  readonly appVersion: string;
  readonly hosted: boolean;
  readonly identity: BrowserIdentity;
  readonly desktopBridge: Pick<DesktopBridge, "getClientPlatform"> | undefined;
}): AuthClientPresentationMetadata {
  if (input.desktopBridge !== undefined) {
    return {
      label: "T3 Code Desktop",
      deviceType: "desktop",
      os: clientOsFromElectronPlatform(input.desktopBridge.getClientPlatform?.()),
      surface: "desktop",
      ...(input.appVersion === "0.0.0" ? {} : { appVersion: input.appVersion }),
    };
  }

  return {
    label: "T3 Code Web",
    deviceType: browserDeviceType(input.identity),
    os: browserClientOs(input.identity),
    surface: "web",
    webDeployment: input.hosted ? "hosted" : "server",
    browser: browserFamily(input.identity.userAgent),
    ...(input.appVersion === "0.0.0" ? {} : { appVersion: input.appVersion }),
  };
}
