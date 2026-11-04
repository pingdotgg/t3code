import * as shield from "@distilled.cloud/aws/shield";
import * as Layer from "effect/Layer";
import { makeShieldHttpBinding } from "./BindingHttp.ts";
import { ListAttacks } from "./ListAttacks.ts";

export const ListAttacksHttp = Layer.effect(
  ListAttacks,
  makeShieldHttpBinding({
    tag: "AWS.Shield.ListAttacks",
    operation: shield.listAttacks,
    actions: ["shield:ListAttacks"],
  }),
);
