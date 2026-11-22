import * as Turso from "@alchemy.run/turso";
import * as Effect from "effect/Effect";

export const BindingGroup = Turso.Group("BindingGroup", { location: "aws-us-east-1" });

export const BindingDb = Effect.gen(function* () {
  const group = yield* BindingGroup;
  return yield* Turso.Database("BindingDb", { group: group.name });
});

export const TenantGroup = Turso.Group("TenantGroup", { location: "aws-us-east-1" });

export const LambdaDb = Effect.gen(function* () {
  const group = yield* Turso.Group("LambdaGroup", { location: "aws-us-east-1" });
  return yield* Turso.Database("LambdaDb", { group: group.name });
});
