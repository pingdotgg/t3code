// Typed without `./$types` — SvelteKit's generated types only exist after
// `svelte-kit sync`, and this fixture is type-checked by the alchemy test
// project without a kit build.
export const load = () => {
  return {
    // Produced by a server `load` — proves the page is server-rendered by
    // the Lambda (or the dev server), not statically served.
    marker: "SVELTEKIT_AWS_PAGE_MARKER",
  };
};
