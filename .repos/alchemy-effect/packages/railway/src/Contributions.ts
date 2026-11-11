import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "railway",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.RailwayAuth,
  ),
});
