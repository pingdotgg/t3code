import { Branch } from "@alchemy.run/neon/Branch";
import { Bucket } from "@alchemy.run/neon/Bucket";
import { Object as NeonObject } from "@alchemy.run/neon/Object";
import { Project } from "@alchemy.run/neon/Project";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const StorageProject = Project("StorageBindingProject", {
  region: "aws-us-east-2",
});
export const StorageBranch = Effect.gen(function* () {
  return yield* Branch("StorageBindingBranch", {
    project: yield* StorageProject,
  });
});
export const StorageBucket = Effect.gen(function* () {
  return yield* Bucket("StorageBindingBucket", {
    branch: yield* StorageBranch,
    forceDestroy: true,
  });
});
export const StorageSettings = Effect.gen(function* () {
  const bucket = yield* StorageBucket;
  return yield* NeonObject("StorageSettings", {
    bucket,
    key: "settings.json",
    value: { theme: "system", pageSize: 25 },
    schema: Schema.Struct({ theme: Schema.String, pageSize: Schema.Number }),
  });
});
