import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "planetscale",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.PlanetscaleAuth,
  ),
});
