import * as Neon from "@/Neon";
import * as Effect from "effect/Effect";

export const backendProject = Neon.Project("BackendBindingProject", {
  region: "aws-us-east-2",
});
export const backendBranch = Effect.gen(function* () {
  return yield* Neon.Branch("BackendBindingBranch", {
    project: yield* backendProject,
  });
});
export const backendAuth = Effect.gen(function* () {
  return yield* Neon.Auth("BackendBindingAuth", {
    branch: yield* backendBranch,
  });
});
export const backendDataApi = Effect.gen(function* () {
  const auth = yield* backendAuth;
  return yield* Neon.DataApi("BackendBindingData", {
    branch: { projectId: auth.projectId, branchId: auth.branchId },
    authProvider: "neon_auth",
  });
});
export const backendGateway = Effect.gen(function* () {
  return yield* Neon.AIGateway("BackendBindingGateway", {
    branch: yield* backendBranch,
  });
});
