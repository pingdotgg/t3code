import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";

import { appAtomRegistry } from "../state/atom-registry";
import { connectionAtomRuntime } from "./runtime";

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

/** Rebuilds the connection runtime, whose construction reads the saved catalog. */
export function retryEnvironmentCatalogLoad(): void {
  appAtomRegistry.refresh(connectionAtomRuntime);
}
