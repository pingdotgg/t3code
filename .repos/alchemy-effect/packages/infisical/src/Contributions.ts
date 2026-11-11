import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "infisical",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.InfisicalAuth,
  ),
});
