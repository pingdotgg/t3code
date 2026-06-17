import type { ProviderDriverKind } from "@t3tools/contracts";

import {
  ClaudeAdapterV2Driver,
  type ClaudeAdapterV2DriverEnv,
} from "./Adapters/ClaudeAdapterV2.ts";
import { CodexAdapterV2Driver, type CodexAdapterV2DriverEnv } from "./Adapters/CodexAdapterV2.ts";
import type { AnyProviderAdapterDriver } from "./ProviderAdapterDriver.ts";

export type BuiltInProviderAdapterDriversV2Env = ClaudeAdapterV2DriverEnv | CodexAdapterV2DriverEnv;

export const BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2: ReadonlyArray<
  AnyProviderAdapterDriver<BuiltInProviderAdapterDriversV2Env>
> = [CodexAdapterV2Driver, ClaudeAdapterV2Driver];

export const BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2: ReadonlySet<ProviderDriverKind> = new Set(
  BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2.map((driver) => driver.driverKind),
);

export const isBuiltInProviderAdapterDriverV2 = (driver: ProviderDriverKind): boolean =>
  BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(driver);
