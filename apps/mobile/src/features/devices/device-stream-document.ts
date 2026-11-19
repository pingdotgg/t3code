import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import type { DevicePlatform } from "@t3tools/contracts";
import type { PlatformOSType } from "react-native";

export interface DeviceStreamConfiguration {
  readonly access: DeviceHubAccess;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  /** See `DeviceStreamTarget.serveSimOnly`. */
  readonly serveSimOnly?: boolean;
  readonly colors: {
    readonly background: string;
    readonly foreground: string;
    readonly muted: string;
    readonly buttonBackground: string;
    readonly buttonForeground: string;
    readonly buttonBorder: string;
  };
  /** Translated in React Native: the WebView cannot load the catalogs. */
  readonly labels: {
    readonly screen: string;
    readonly reconnectingControls: string;
  };
}

export function deviceStreamBaseUrl(
  viewerPlatform: PlatformOSType,
  devicePlatform: DevicePlatform,
  httpBase: string,
) {
  if (viewerPlatform !== "android") return "file:///";
  // Android targets stream through WebCodecs, which needs a secure context. iOS targets
  // stream an MJPEG image from the environment, which a synthetic https document blocks as
  // mixed content on plain-http environments even with mixedContentMode="always".
  if (devicePlatform === "android") return "https://localhost/";
  return `${new URL(httpBase).origin}/`;
}

export function deviceStreamDocument(
  configuration: string,
  script: string,
  stoppedDetail = "Device viewer stopped unexpectedly.",
) {
  const safeConfiguration = configuration.replace(/</g, "\\u003c");
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const safeStoppedDetail = JSON.stringify(stoppedDetail).replace(/</g, "\\u003c");
  const failure = `window.ReactNativeWebView.postMessage(JSON.stringify({type:"status",status:"error",detail:${safeStoppedDetail}}));`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"></head><body><script>window.addEventListener("error",function(){${failure}});window.addEventListener("unhandledrejection",function(){${failure}});\n${safeScript}\ntry{T3DeviceStream.start(${safeConfiguration});}catch{${failure}}</script></body></html>`;
}

export function deviceStreamMessage(data: string) {
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null || !("type" in message)) return null;
    if (message.type === "unauthorized" || message.type === "retry") {
      return { type: message.type } as const;
    }
    if (
      message.type === "input" &&
      "connected" in message &&
      typeof message.connected === "boolean"
    ) {
      return { type: message.type, connected: message.connected } as const;
    }
    if (
      message.type === "status" &&
      "status" in message &&
      (message.status === "connecting" ||
        message.status === "streaming" ||
        message.status === "error") &&
      (!("detail" in message) || typeof message.detail === "string")
    ) {
      return {
        type: message.type,
        status: message.status,
        detail:
          "detail" in message && typeof message.detail === "string" ? message.detail : undefined,
      } as const;
    }
  } catch {}
  return null;
}
