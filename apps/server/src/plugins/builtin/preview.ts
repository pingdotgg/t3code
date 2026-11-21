import * as Layer from "effect/Layer";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as DeviceHubProxy from "../../device/DeviceHubProxy.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as PreviewTunnel from "../../preview/PreviewTunnel.ts";
import * as ServerBrowser from "../../preview/ServerBrowser.ts";
import * as PreviewAgentActivity from "../../preview/PreviewAgentActivity.ts";
import * as DesktopBrowserChannel from "../../preview/DesktopBrowserChannel.ts";
import * as ServerBrowserStream from "../../preview/ServerBrowserStream.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as NetService from "@t3tools/shared/Net";
import { layerBackground } from "./resources.ts";
import { layerServerSettings } from "./settings.ts";

export const layerPortScanner = PortScanner.layer.pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(layerBackground),
);

export const layerPreview = Layer.empty.pipe(
  Layer.provideMerge(PreviewTunnel.layer),
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(layerPortScanner),
);

export const layerDevice = DeviceService.layer.pipe(
  Layer.provide(layerServerSettings),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NetService.layer),
);

// The same activity instance RunExecutionService reports to, by layer memoization.
export const layerServerBrowser = ServerBrowser.layer.pipe(
  Layer.provide(Layer.merge(DesktopBrowserChannel.layer, PreviewAgentActivity.layer)),
);

export const layerPreviewBrowser = PreviewBrowser.layer;

export const layerPreviewAutomationBroker = PreviewAutomationBroker.layer;

export const layerDeviceHubProxy = DeviceHubProxy.layer;

export const layerBrowserStreamRoute = ServerBrowserStream.routeLayer;

export const layerPreviewTunnelRoute = PreviewTunnel.routeLayer;
