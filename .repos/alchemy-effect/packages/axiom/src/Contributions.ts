import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "axiom",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.AxiomAuth,
  ),
});
