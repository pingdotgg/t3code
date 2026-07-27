import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/**
 * The script every node runs when it joins the cluster. Real clusters
 * install schedulers, mount FSx volumes, and configure observability here —
 * see https://github.com/aws-samples/awsome-distributed-training for the
 * full-featured base configuration.
 */
const ON_CREATE_SH = `#!/bin/bash
set -euo pipefail
echo "HyperPod node $(hostname) provisioned by alchemy"
`;

/**
 * Deploy-time Action that uploads the lifecycle script to the bucket. It
 * runs after the bucket exists (its input captures the bucket's resolved
 * name) and before the cluster is created (the cluster's props capture its
 * output) — the dependency chain is inferred, and the body only re-runs
 * when its input changes.
 */
export const UploadLifecycleScript = Alchemy.Action(
  "UploadLifecycleScript",
  (input: { bucketName: string }) =>
    Effect.gen(function* () {
      yield* s3.putObject({
        Bucket: input.bucketName,
        Key: "lifecycle/on_create.sh",
        Body: new TextEncoder().encode(ON_CREATE_SH),
        ContentType: "text/x-shellscript",
      });
      return {
        sourceS3Uri: `s3://${input.bucketName}/lifecycle`,
        onCreate: "on_create.sh",
      };
    }),
);
