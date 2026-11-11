import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "hetzner",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.HetznerAuth,
  ),
});
