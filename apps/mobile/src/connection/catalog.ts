import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import { createAtomCommandScheduler } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "./runtime";

export const environmentCatalogCommandScheduler = createAtomCommandScheduler();

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime, {
  commandScheduler: environmentCatalogCommandScheduler,
});
