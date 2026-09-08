// Typed without `./$types` so the example type-checks before the first
// build (SvelteKit's generated types only exist after `svelte-kit sync`).
export const load = ({ platform }: { platform?: App.Platform }) => {
  return {
    greeting: platform?.env?.GREETING ?? "Hello!",
  };
};
