import { createProviderWorkspaceSnapshotRefreshAtomFamily } from "@t3tools/client-runtime/providerSkills";

import { serverEnvironment } from "./server";

/** Shared by the composer and the model picker so one cwd scans once. */
export const providerWorkspaceSnapshotRefresh = createProviderWorkspaceSnapshotRefreshAtomFamily({
  providers: serverEnvironment.providersValueAtom,
  refreshProviders: serverEnvironment.refreshProviders,
});
