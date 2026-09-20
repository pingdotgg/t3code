import type { EnvironmentId } from "@t3tools/contracts";

import { createAtomCommandScheduler, type AtomCommandConcurrency } from "./runtime.ts";

export const vcsCommandScheduler = createAtomCommandScheduler();

/** Keeps background remote refreshes from delaying user-initiated repository mutations. */
export const vcsRemoteRefreshCommandScheduler = createAtomCommandScheduler();

/** Coalesces status polling independently from repository mutations and remote refreshes. */
export const vcsStatusRefreshCommandScheduler = createAtomCommandScheduler();

export const vcsCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};

export const vcsRemoteRefreshCommandConcurrency = vcsCommandConcurrency;

export const vcsStatusRefreshCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "latest",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};
