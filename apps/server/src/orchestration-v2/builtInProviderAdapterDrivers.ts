import type { ProviderDriverKind } from "@t3tools/contracts";

import {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverEnv,
} from "./Adapters/AcpRegistryAdapterV2.ts";
import {
  ClaudeAdapterV2Driver,
  type ClaudeAdapterV2DriverEnv,
} from "./Adapters/ClaudeAdapterV2.ts";
import { CodexAdapterV2Driver, type CodexAdapterV2DriverEnv } from "./Adapters/CodexAdapterV2.ts";
import {
  CursorAdapterV2Driver,
  type CursorAdapterV2DriverEnv,
} from "./Adapters/CursorAdapterV2.ts";
import { GrokAdapterV2Driver, type GrokAdapterV2DriverEnv } from "./Adapters/GrokAdapterV2.ts";
import {
  OpenCodeAdapterV2Driver,
  type OpenCodeAdapterV2DriverEnv,
} from "./Adapters/OpenCodeAdapterV2.ts";
import type { AnyProviderAdapterDriver } from "./ProviderAdapterDriver.ts";

export type BuiltInProviderAdapterDriversV2Env =
  | AcpRegistryAdapterV2DriverEnv
  | ClaudeAdapterV2DriverEnv
  | CodexAdapterV2DriverEnv
  | CursorAdapterV2DriverEnv
  | GrokAdapterV2DriverEnv
  | OpenCodeAdapterV2DriverEnv;

export const BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2: ReadonlyArray<
  AnyProviderAdapterDriver<BuiltInProviderAdapterDriversV2Env>
> = [
  CodexAdapterV2Driver,
  ClaudeAdapterV2Driver,
  CursorAdapterV2Driver,
  OpenCodeAdapterV2Driver,
  GrokAdapterV2Driver,
  AcpRegistryAdapterV2Driver,
];

export const BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2: ReadonlySet<ProviderDriverKind> = new Set(
  BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2.map((driver) => driver.driverKind),
);

export const isBuiltInProviderAdapterDriverV2 = (driver: ProviderDriverKind): boolean =>
  BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(driver);
