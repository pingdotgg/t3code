import { useEnvironmentProvider } from "./environmentProvider";

/**
 * Conn: a profile sync run belongs to the provider mode it started in. `begin` returns a check
 * that turns false once the provider changes, so a reply from before an Orbit off/on applies
 * nothing; the provider change queues a fresh run for the current mode.
 */
export function createProviderRunGuard(): { readonly begin: () => () => boolean } {
  let epoch = 0;
  useEnvironmentProvider.subscribe((state, previous) => {
    if (state.provider !== previous.provider) epoch += 1;
  });
  return {
    begin: () => {
      const started = epoch;
      return () => started === epoch;
    },
  };
}
