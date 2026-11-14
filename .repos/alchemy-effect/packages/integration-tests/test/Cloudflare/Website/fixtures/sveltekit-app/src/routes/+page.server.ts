// Typed with a local Platform shape (no `./$types`, no global `App`
// namespace) — SvelteKit's generated types only exist after
// `svelte-kit sync`, and this fixture is type-checked by the alchemy test
// project without a kit build.
interface Platform {
  env?: { TEST_BINDING?: string };
  ctx?: { waitUntil(promise: Promise<unknown>): void };
}

export const load = ({ platform }: { platform?: Platform }) => {
  return {
    binding: platform?.env?.TEST_BINDING ?? "no-platform-env",
    hasCtx: typeof platform?.ctx?.waitUntil === "function",
  };
};
