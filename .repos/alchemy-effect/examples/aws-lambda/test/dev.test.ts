/**
 * True `alchemy dev` end-to-end for the Job app — the regression test for
 * the dev-mode apply failure where the SNS→Lambda glue resources
 * (AWS.SNS.Subscription and the AWS.Lambda.Permission behind
 * `consumeTopicNotifications`) were created against REAL AWS with floci
 * ARNs and died with `InvalidParameterException: Invalid parameter:
 * TopicArn` / `ResourceNotFoundException: Function not found`.
 *
 * This stack is also the mixed-mode case: the DynamoDB table, SQS queue,
 * SNS topic, Lambda function, event source mapping, subscription, and
 * permission are all local (floci), while the mode-agnostic CloudWatch
 * Dashboard + Alarm deploy live — so the run needs AWS credentials, and a
 * green apply proves local glue and live mode-agnostic resources coexist.
 *
 * Mirrored from examples/aws-dev/test/dev.test.ts (which owns the broader
 * per-binding + hot-reload coverage); this suite drives the real app:
 * POST a job over the emulator-served Function URL, read it back, and let
 * the notification publish ride the local Subscription.
 */
import { afterAll, expect, test } from "bun:test";
import { DevCli, fetchOk } from "alchemy-test/DevCli";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const STAGE = "dev-cli-test";
const cli = new DevCli({ root, stage: STAGE });

// The whole suite needs docker (floci runs as a container).
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

afterAll(async () => {
  await cli.stop();
  if (!process.env.NO_DESTROY && dockerAvailable) {
    cli.destroy();
  }
}, 180_000);

test.skipIf(!dockerAvailable)(
  "alchemy dev applies the mixed local/live Job stack and serves jobs",
  async () => {
    cli.start();

    // The first dev deploy may pull the floci image and provision the
    // local data plane before printing stack outputs.
    const url = await cli.pollUntil(
      "url in stack outputs",
      () => cli.outputUrl("url"),
      { tries: 300, delayMs: 1000 },
    );

    // Dev identity: the function URL is served locally, not by AWS
    // (e.g. http://<id>.lambda-url.us-east-1.localhost:<port>/). The port
    // is whatever the emulator bound — never hard-code it, only the URL
    // captured from the CLI's stdout is authoritative.
    expect(new URL(url).hostname).toEndWith("localhost");
    expect(url).not.toContain("amazonaws.com");

    // The bug failed the APPLY itself: Subscription/Permission creation
    // against real AWS with floci ARNs. Outputs printing means apply
    // succeeded, but pin the failure banner too so a partial apply that
    // still prints outputs can never sneak past.
    expect(cli.output).not.toContain("apply failed");

    const api = new URL(url);
    api.search = "";

    // POST a job: stores it in the local table AND publishes the
    // job.created notification over the local topic — which only works
    // when the Subscription + invoke Permission were created on floci.
    const content = `hello from alchemy dev ${crypto.randomUUID()}`;
    const created = (await (
      await fetchOk(api, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: content,
      })
    ).json()) as { jobId: string };
    expect(created.jobId).toBeString();

    // Read it back through the local DynamoDB storage.
    const job = (await (
      await fetchOk(new URL(`/?jobId=${created.jobId}`, api))
    ).json()) as { id: string; content: string };
    expect(job.id).toBe(created.jobId);
    expect(job.content).toBe(content);
  },
  { timeout: 600_000 },
);
