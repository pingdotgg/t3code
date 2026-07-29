import * as signer from "@distilled.cloud/aws/signer";
import * as Layer from "effect/Layer";
import { makeSignerHttpBinding } from "./BindingHttp.ts";
import { DescribeSigningJob } from "./DescribeSigningJob.ts";

export const DescribeSigningJobHttp = Layer.effect(
  DescribeSigningJob,
  makeSignerHttpBinding({
    tag: "AWS.Signer.DescribeSigningJob",
    operation: signer.describeSigningJob,
    actions: ["signer:DescribeSigningJob"],
  }),
);
