/**
 * SQS-consumer fixture for the floci dev ESM test, deployed with
 * `bundle: false` (the directory ships as-is). Plain `.mjs` because
 * `@aws-sdk/client-s3` is not a workspace dependency — the Lambda runtime
 * image provides it, and floci injects `AWS_ENDPOINT_URL` + placeholder
 * credentials so the SDK targets the emulator. Path-style is forced because
 * virtual-host bucket DNS does not resolve locally.
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.AWS_ENDPOINT_URL,
  forcePathStyle: true,
});

export const handler = async (event) => {
  for (const record of event.Records ?? []) {
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.TARGET_BUCKET,
        Key: record.body,
        Body: record.messageId,
      }),
    );
  }
  return { batchItemFailures: [] };
};
