import type { SandboxProviderDriver } from "../SandboxProvider.ts";
import { boatDriver } from "./boat.ts";
import { daytonaDriver } from "./daytona.ts";

/**
 * Every sandbox provider is one driver in this list. A new provider implements
 * `SandboxProviderDriver` (create, execute, exposePort, destroy) in its own file and adds one
 * entry here; the server contract, settings, provisioning flow, and UI pick it up from the
 * driver's `info` without further changes.
 */
export const SANDBOX_PROVIDER_DRIVERS: ReadonlyArray<SandboxProviderDriver> = [
  boatDriver,
  daytonaDriver,
];
