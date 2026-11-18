import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Layer from "effect/Layer";
import { makeS3ControlAccountHttpBinding } from "./BindingHttp.ts";
import { ListAccessPoints } from "./ListAccessPoints.ts";

export const ListAccessPointsHttp = Layer.effect(
  ListAccessPoints,
  makeS3ControlAccountHttpBinding({
    tag: "AWS.S3Control.ListAccessPoints",
    operation: s3control.listAccessPoints,
    actions: ["s3:ListAccessPoints"],
  }),
);
