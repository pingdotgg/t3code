import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { PostLineageEvent } from "./PostLineageEvent.ts";

export const PostLineageEventHttp = Layer.effect(
  PostLineageEvent,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.PostLineageEvent",
    operation: datazone.postLineageEvent,
    actions: ["datazone:PostLineageEvent"],
  }),
);
