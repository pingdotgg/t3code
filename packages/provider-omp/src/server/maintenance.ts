import { ProviderDriverKind } from "@t3tools/contracts";
import {
  makePackageManagedProviderMaintenanceResolver,
  type PackageManagedProviderMaintenanceDefinition,
} from "@t3tools/provider-core/server/maintenanceResolver";

export const ompMaintenanceDefinition: PackageManagedProviderMaintenanceDefinition = {
  provider: ProviderDriverKind.make("omp"),
  npmPackageName: "@oh-my-pi/pi-coding-agent",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: (commandPath) => /(?:^|[\\/])omp(?:\.exe)?$/.test(commandPath),
  },
};
export const ompMaintenance =
  makePackageManagedProviderMaintenanceResolver(ompMaintenanceDefinition);
