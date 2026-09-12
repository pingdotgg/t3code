/**
 * Raw (non-distilled) HTTP helpers against the floci emulator gateway —
 * out-of-band proof that a resource exists IN THE EMULATOR, not the real
 * cloud. The dummy SigV4 Authorization header is never verified by the
 * emulator; it only carries the service/region/account scoping the gateway
 * routes by.
 */
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { spawnSync } from "node:child_process";

export const FLOCI_ENDPOINT = "http://localhost:4566";

/**
 * skipIf gate: floci runs as a Docker container. `docker info` proves the
 * daemon is reachable (a mere `docker --version` would pass with the daemon
 * down). Sync probe at collection time — skipIf needs a plain boolean.
 */
export const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

/** POST an AWS-JSON operation straight at the emulator gateway. */
export const rawAwsJson = Effect.fn(function* (options: {
  service: string;
  region: string;
  target: string;
  contentType: string;
  body: Record<string, unknown>;
}) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(
    HttpClientRequest.post(`${FLOCI_ENDPOINT}/`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": options.contentType,
        "x-amz-target": options.target,
        "x-amz-date": "20260101T000000Z",
        authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/${options.region}/${options.service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=dummy`,
      }),
      HttpClientRequest.setBody(
        HttpBody.text(JSON.stringify(options.body), options.contentType),
      ),
    ),
  );
});

/** POST an AWS query-protocol operation (SNS, …) straight at the gateway. */
export const rawAwsQuery = Effect.fn(function* (options: {
  service: string;
  region: string;
  params: Record<string, string>;
}) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(
    HttpClientRequest.post(`${FLOCI_ENDPOINT}/`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/x-www-form-urlencoded",
        "x-amz-date": "20260101T000000Z",
        authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/${options.region}/${options.service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=dummy`,
      }),
      HttpClientRequest.setBody(
        HttpBody.text(
          new URLSearchParams(options.params).toString(),
          "application/x-www-form-urlencoded",
        ),
      ),
    ),
  );
});

/** Path-style S3 GET against the gateway (list the bucket's objects). */
export const rawS3GetBucket = Effect.fn(function* (bucketName: string) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(
    HttpClientRequest.get(`${FLOCI_ENDPOINT}/${bucketName}`).pipe(
      HttpClientRequest.setHeaders({
        "x-amz-date": "20260101T000000Z",
        authorization:
          "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=dummy",
      }),
    ),
  );
});

/** Path-style S3 object GET against the gateway. */
export const rawS3GetObject = Effect.fn(function* (
  bucketName: string,
  key: string,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(
    HttpClientRequest.get(`${FLOCI_ENDPOINT}/${bucketName}/${key}`).pipe(
      HttpClientRequest.setHeaders({
        "x-amz-date": "20260101T000000Z",
        authorization:
          "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=dummy",
      }),
    ),
  );
});

/** Region segment of an ARN (`arn:aws:sqs:REGION:ACCOUNT:name`). */
export const regionOfArn = (arn: string) => arn.split(":")[3]!;
