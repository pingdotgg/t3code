import {
  resolveDeviceModelId,
  type DeviceAccessorySource,
  type DeviceModelSource,
} from "@t3tools/client-runtime/device/model";
import type { DevicePlatform } from "@t3tools/contracts";
import iphoneDuo from "./models/iphone-duo.glb?url";
import iphone18Pro from "./models/iphone-18-pro.glb?url";
import iphone18ProMax from "./models/iphone-18-pro-max.glb?url";
import iphone17 from "./models/iphone-17.glb?url";
import iphoneAir from "./models/iphone-air.glb?url";
import iphone17e from "./models/iphone-17e.glb?url";
import iphone17Pro from "./models/iphone-17-pro.glb?url";
import iphone17ProMax from "./models/iphone-17-pro-max.glb?url";
import iphone16Pro from "./models/iphone-16-pro.glb?url";
import iphone16ProMax from "./models/iphone-16-pro-max.glb?url";
import iphone16 from "./models/iphone-16.glb?url";
import iphone16Plus from "./models/iphone-16-plus.glb?url";
import iphone15 from "./models/iphone-15.glb?url";
import iphone15Plus from "./models/iphone-15-plus.glb?url";
import iphone14 from "./models/iphone-14.glb?url";
import iphone14Plus from "./models/iphone-14-plus.glb?url";
import magicKeyboard from "./models/ipad-pro-13-m5-magic-keyboard.glb?url";
import ipadPro13M5 from "./models/ipad-pro-13-m5.glb?url";

const models: Record<DeviceModelSource["id"], DeviceModelSource> = {
  "iphone-duo": { id: "iphone-duo", url: iphoneDuo },
  "iphone-18-pro": { id: "iphone-18-pro", url: iphone18Pro },
  "iphone-18-pro-max": { id: "iphone-18-pro-max", url: iphone18ProMax },
  "iphone-17": { id: "iphone-17", url: iphone17 },
  "iphone-air": { id: "iphone-air", url: iphoneAir },
  "iphone-17e": { id: "iphone-17e", url: iphone17e },
  "iphone-17-pro": { id: "iphone-17-pro", url: iphone17Pro },
  "iphone-17-pro-max": { id: "iphone-17-pro-max", url: iphone17ProMax },
  "iphone-16-pro": { id: "iphone-16-pro", url: iphone16Pro },
  "iphone-16-pro-max": { id: "iphone-16-pro-max", url: iphone16ProMax },
  "iphone-16": { id: "iphone-16", url: iphone16 },
  "iphone-16-plus": { id: "iphone-16-plus", url: iphone16Plus },
  "iphone-15": { id: "iphone-15", url: iphone15 },
  "iphone-15-plus": { id: "iphone-15-plus", url: iphone15Plus },
  "iphone-14": { id: "iphone-14", url: iphone14 },
  "iphone-14-plus": { id: "iphone-14-plus", url: iphone14Plus },
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
