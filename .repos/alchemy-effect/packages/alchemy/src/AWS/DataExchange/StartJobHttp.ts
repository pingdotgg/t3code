import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { StartJob } from "./StartJob.ts";

/**
 * Bespoke implementation (not the shared account builder): a started job
 * runs with the caller's forwarded permissions, so on top of the
 * `dataexchange:*` actions it needs S3 access to AWS Data Exchange's own
 * service buckets (`arn:aws:s3:::*aws-data-exchange*`) — import jobs write
 * staged assets there (`s3:PutObject`/`s3:PutObjectAcl`), export jobs read
 * them (`s3:GetObject`). Mirrors the AWS-managed
 * `AWSDataExchangeProviderFullAccess` policy, including the `aws:CalledVia`
 * condition that limits the S3 grant to calls made through Data Exchange.
 */
export const StartJobHttp = Layer.effect(
  StartJob,
  Effect.gen(function* () {
    const op = yield* dataexchange.startJob;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DataExchange.StartJob())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "dataexchange:StartJob",
                  "dataexchange:CreateAsset",
                  "dataexchange:GetAsset",
                ],
                Resource: ["*"],
              },
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:PutObject", "s3:PutObjectAcl"],
                Resource: ["arn:aws:s3:::*aws-data-exchange*"],
                Condition: {
                  "ForAnyValue:StringEquals": {
                    "aws:CalledVia": ["dataexchange.amazonaws.com"],
                  },
                },
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.DataExchange.StartJob")(function* (
        request: dataexchange.StartJobRequest,
      ) {
        return yield* op(request);
      });
    });
  }),
);
