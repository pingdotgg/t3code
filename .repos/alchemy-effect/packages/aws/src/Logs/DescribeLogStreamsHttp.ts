import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { DescribeLogStreams } from "./DescribeLogStreams.ts";

export const DescribeLogStreamsHttp = Layer.effect(
  DescribeLogStreams,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.DescribeLogStreams",
    operation: Logs.describeLogStreams,
    actions: ["logs:DescribeLogStreams"],
  }),
);
