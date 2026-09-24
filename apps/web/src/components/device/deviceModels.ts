import {
  resolveDeviceModelId,
  type DeviceAccessorySource,
  type DeviceModelSource,
} from "@t3tools/client-runtime/device/model";
import type { DevicePlatform } from "@t3tools/contracts";
import iphone18Pro from "./models/iphone-18-pro.glb?url";
import iphone18ProMax from "./models/iphone-18-pro-max.glb?url";
import magicKeyboard from "./models/ipad-pro-13-m5-magic-keyboard.glb?url";
import ipadPro13M5 from "./models/ipad-pro-13-m5.glb?url";

// Bundled URLs follow the client origin in local, desktop, hosted and remote sessions.
const models: Record<DeviceModelSource["id"], DeviceModelSource> = {
  "iphone-18-pro": { id: "iphone-18-pro", url: iphone18Pro },
  "iphone-18-pro-max": { id: "iphone-18-pro-max", url: iphone18ProMax },
  "ipad-pro-13-m5": { id: "ipad-pro-13-m5", url: ipadPro13M5 },
};

export function deviceModel(platform: DevicePlatform, name: string): DeviceModelSource | null {
  const id = resolveDeviceModelId(platform, name);
  return id ? models[id] : null;
}

const keyboard: DeviceAccessorySource = {
  id: "ipad-pro-13-m5-magic-keyboard",
  modelId: "ipad-pro-13-m5",
  url: magicKeyboard,
};

export function deviceKeyboard(
  platform: DevicePlatform,
  name: string,
): DeviceAccessorySource | null {
  return resolveDeviceModelId(platform, name) === keyboard.modelId ? keyboard : null;
}
