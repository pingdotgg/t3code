import type { SandboxProviderDriver } from "../SandboxProvider.ts";
import { boatDriver } from "./boat.ts";
import { daytonaDriver } from "./daytona.ts";
import { vercelDriver } from "./vercel.ts";

/**
 * Every sandbox provider is one driver in this list. A new provider implements
 * `SandboxProviderDriver` (create, execute, exposePort, destroy) in its own file, adds one entry
 * here, its kind to `SandboxProviderKind`, and its mark to `SandboxProviderLogo`; settings,
 * provisioning, and the rest of the UI follow from the driver's `info`.
 */
export const SANDBOX_PROVIDER_DRIVERS: ReadonlyArray<SandboxProviderDriver> = [
  boatDriver,
  daytonaDriver,
  vercelDriver,
];
