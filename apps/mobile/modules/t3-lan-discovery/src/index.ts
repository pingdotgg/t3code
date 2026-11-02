import { requireOptionalNativeModule } from "expo";

export interface LanService {
  id: string;
  environmentId: string;
  addresses: string[];
  port: number;
}

export interface LanDiscoveryEvent {
  services: LanService[];
}

type Subscription = { remove(): void };
type NativeDiscovery = {
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  addListener(event: "servicesChanged", listener: (event: LanDiscoveryEvent) => void): Subscription;
};

const native = requireOptionalNativeModule<NativeDiscovery>("T3LanDiscovery");

export const lanDiscovery: NativeDiscovery = native ?? {
  start: async () => {},
  stop: async () => {},
  refresh: async () => {},
  addListener: () => ({ remove() {} }),
};
