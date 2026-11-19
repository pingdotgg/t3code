import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";
import { ListChannels } from "./ListChannels.ts";

export const ListChannelsHttp = Layer.effect(
  ListChannels,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.ListChannels",
    operation: repostspace.listChannels,
    actions: ["repostspace:ListChannels"],
  }),
);
