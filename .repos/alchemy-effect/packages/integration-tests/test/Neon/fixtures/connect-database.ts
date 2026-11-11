import { Branch } from "@alchemy.run/neon/Branch";
import { Project } from "@alchemy.run/neon/Project";
import * as Effect from "effect/Effect";

export const ConnectProject = Project("ConnectProject", {
  region: "aws-us-east-2",
});
export const ConnectBranch = Effect.gen(function* () {
  const project = yield* ConnectProject;
  return yield* Branch("ConnectBranch", { project });
});
