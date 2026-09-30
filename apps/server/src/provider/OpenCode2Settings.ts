/**
 * OpenCode2Settings — settings schema for the standalone `opencode2` driver.
 *
 * Single source of truth: re-exported from `@t3tools/contracts` (the shared
 * form schema web/mobile/desktop render from). It is field-for-field the
 * OpenCode v1 shape (binary path, server URL, server password, custom
 * models) with `opencode` fallback copy, so the driver decodes the exact
 * same defaults and round-trips the same payloads — no drift possible.
 *
 * The driver slug is owned here (`OPENCODE2_DRIVER_KIND`) and shared by the
 * driver, snapshot helpers, and adapter stub so the three can never disagree.
 *
 * Version-probe note: both the local-binary and external-server paths
 * probe through the shared `../opencodeVersionProbe.ts`
 * (`probeOpenCodeRuntime`); the driver memoizes the probe per instance and
 * refreshes it on every status check so in-place upgrades re-route.
 *
 * @module provider/OpenCode2Settings
 */
import {
  OpenCode2Settings as ContractsOpenCode2Settings,
  ProviderDriverKind,
} from "@t3tools/contracts";

/**
 * Driver-kind slug for the OpenCode 2 provider. Single source of truth —
 * the driver, snapshot helpers, and adapter stub all reference this value.
 */
export const OPENCODE2_DRIVER_KIND = ProviderDriverKind.make("opencode2");

export const OpenCode2Settings = ContractsOpenCode2Settings;
export type OpenCode2Settings = ContractsOpenCode2Settings;
