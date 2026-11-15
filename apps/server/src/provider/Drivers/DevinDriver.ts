import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

import { ProviderDriverError } from "../Errors.ts";
import {
  DevinUsageConfig,
  devinUsageReader,
  type DevinUsageReaderEnv,
} from "./devinUsageReader.ts";

const DRIVER = ProviderDriverKind.make("devin");

// Usage-only source for the Devin CLI's local sessions database; registered in
// BUILT_IN_USAGE_DRIVERS and never as a startable provider.
export const DevinDriver: ProviderDriver<DevinUsageConfig, never, DevinUsageReaderEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Devin", supportsMultipleInstances: false },
  configSchema: DevinUsageConfig,
  defaultConfig: () => ({}),
  usage: devinUsageReader,
  create: ({ instanceId }) =>
    Effect.fail(
      new ProviderDriverError({
        driver: DRIVER,
        instanceId,
        detail: "Devin contributes local usage history only.",
      }),
    ),
};
