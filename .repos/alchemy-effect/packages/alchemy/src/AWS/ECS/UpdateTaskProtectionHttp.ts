import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toWireMinutes } from "../../Util/Duration.ts";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import {
  UpdateTaskProtection,
  type UpdateTaskProtectionRequest,
} from "./UpdateTaskProtection.ts";

export const UpdateTaskProtectionHttp = Layer.effect(
  UpdateTaskProtection,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.UpdateTaskProtection",
    // Wrap the distilled operation so the binding accepts a Duration.Input
    // `expiresIn` and converts it to the wire's whole minutes.
    //
    // The operation must be *yielded* (its `Symbol.iterator`/`asEffect`
    // protocol), never passed to `Effect.map`: an `API.OperationMethod` is a
    // plain callable that is not `Effect.isEffect`, so `Effect.map` wraps it
    // into an invalid effect that crashes the fiber at run time with
    // "Not a valid effect: function ...".
    operation: Effect.gen(function* () {
      const op = yield* ECS.updateTaskProtection;
      return ({
        expiresIn,
        ...request
      }: UpdateTaskProtectionRequest & { cluster: string }) =>
        op({ ...request, expiresInMinutes: toWireMinutes(expiresIn) });
    }),
    actions: ["ecs:UpdateTaskProtection"],
    // Authorizes against the task resource:
    // arn:aws:ecs:{region}:{account}:task/{clusterName}/*
    resources: ["task"],
  }),
);
