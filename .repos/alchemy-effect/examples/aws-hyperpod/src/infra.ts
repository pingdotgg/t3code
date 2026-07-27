import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/**
 * Shared infrastructure for the HyperPod cluster.
 *
 * Resources are memoized by logical id, so this Effect can be yielded from
 * the stack program and from any other module and always converges on the
 * same single resource instances.
 */
export const HyperPodInfra = Effect.gen(function* () {
  /**
   * The bucket holding the cluster's lifecycle scripts. Every HyperPod
   * instance group downloads and runs its `OnCreate` script from S3 when a
   * node boots.
   */
  const bucket = yield* AWS.S3.Bucket("LifecycleScripts", {
    forceDestroy: true,
  });

  /**
   * The instance execution role. HyperPod nodes assume it to pull the
   * lifecycle script (inline grant on the bucket) and to publish logs and
   * metrics (the AWS-managed cluster-instance policy).
   */
  const role = yield* AWS.IAM.Role("HyperPodInstanceRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "sagemaker.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy",
    ],
    inlinePolicies: {
      "lifecycle-scripts": {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:ListBucket"],
            Resource: [
              bucket.bucketArn,
              Output.interpolate`${bucket.bucketArn}/*`,
            ],
          },
        ],
      },
    },
  });

  return { bucket, role };
});
