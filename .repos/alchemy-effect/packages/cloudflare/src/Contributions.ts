import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "cloudflare",
  auth: Contributions.lazy(
    () => import("./Auth/AuthProvider.ts"),
    (module) => module.CloudflareAuth,
  ),
  stateStores: {
    cloudflare: {
      description: "State-store Worker in the profile's Cloudflare account",
      load: Contributions.lazy(
        () => import("./Alchemist/StateStore.ts"),
        (module) => module.stateStore,
      ),
    },
  },
  cli: {
    provider: {
      description: "Manage Cloudflare provider prerequisites",
      load: Contributions.lazy(
        () => import("./Cli.ts"),
        (module) => module.cloudflareCommand,
      ),
    },
  },
});
