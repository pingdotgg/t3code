// Local Platform shape — kit's generated types only exist after
// `svelte-kit sync`; this fixture is type-checked by the alchemy test
// project without a kit build.
interface Platform {
  env?: { TEST_BINDING?: string };
}

export const load = ({ platform }: { platform?: Platform }) => ({
  binding: platform?.env?.TEST_BINDING ?? "no-platform-env",
});
