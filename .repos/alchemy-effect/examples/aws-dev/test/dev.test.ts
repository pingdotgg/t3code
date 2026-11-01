/**
 * True `alchemy dev` end-to-end for AWS: spawns the REAL CLI and drives
 * every local binding over HTTP against the floci emulator.
 *
 * This is a different code path from the `Test.make({ dev: true })` harness
 * suites under packages/alchemy/test/AWS — the harness mirrors the RPC
 * sidecar topology, but only this test covers the CLI itself: arg parsing,
 * the `bin/exec` child under `--watch`, the `ALCHEMY_RPC_SPAWNER_URL`
 * handshake, and provider sidecars whose lifetime is tied to the CLI
 * process (the #1007 bug class, mirrored from
 * examples/cloudflare-dev/test/dev.test.ts).
 *
 * Coverage, all against floci (no cloud credentials, no cloud resources):
 *   - Function URL       → `/` serves through the emulator's URL proxy
 *   - env vars           → `/` echoes MY_VARIABLE via effect/Config
 *   - S3 binding         → `/s3` PutObject/GetObject roundtrip
 *   - DynamoDB binding   → `/dynamo` PutItem/GetItem roundtrip
 *   - SQS + consumer     → `/queue/send` produces; floci's ESM poller
 *                          delivers to `consumeQueueMessages`, which records
 *                          into the table read back by `/queue/messages`
 *   - SNS + consumer     → `/topic/send` publishes; the lambda-protocol
 *                          Subscription + invoke Permission (glue that must
 *                          be created ON the emulator, not real AWS) deliver
 *                          to `consumeTopicNotifications`, read back by
 *                          `/topic/messages`
 *   - DynamoDB Streams   → `/items` writes; the table stream + its
 *                          EventSourceMapping deliver the change record to
 *                          `consumeTableChanges`, read back by `/changes`
 *   - Action data plane  → the deploy-time SeedObject Action put/gets an
 *                          object through the S3 bindings inside the CLI
 *                          process; the stack outputs carry the dummy
 *                          account id (000000000000) proving the calls hit
 *                          the emulator, not real AWS
 *   - HOT RELOAD         → rewriting src/marker.ts (no redeploy) must serve
 *                          the new marker; restoring it must swap back
 */
import { afterAll, expect, test } from "bun:test";
import { DevCli, fetchOk } from "alchemy-test/DevCli";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const STAGE = "dev-cli-test";
// Credential-free dev, deterministically: an isolated (unconfigured)
// alchemy profile plus stripped AWS env credentials keep this suite
// hermetic — it must pass on a machine with zero AWS configuration, and
// must never touch a developer's real profile. (Action data-plane calls
// are routed to the emulator per bound resource by the engine regardless
// of ambient credentials — see Binding.Service's data-plane routing.)
const cli = new DevCli({
  root,
  stage: STAGE,
  env: {
    ALCHEMY_PROFILE: "aws-dev-cli-test",
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_SESSION_TOKEN: undefined,
    AWS_PROFILE: undefined,
  },
});

const markerPath = path.join(root, "src", "marker.ts");
const markerSource = fs.readFileSync(markerPath, "utf8");

// The whole suite needs docker (floci runs as a container).
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(markerPath, markerSource);

  await cli.stop();
  if (!process.env.NO_DESTROY && dockerAvailable) {
    cli.destroy();
  }
}, 180_000);

test.skipIf(!dockerAvailable)(
  "alchemy dev serves every local AWS binding end-to-end with hot reload",
  async () => {
    cli.start();

    // The first dev deploy may pull the floci image, provision the local
    // data plane, and package the function before printing stack outputs.
    const api = await cli.pollUntil(
      "api url in stack outputs",
      () => cli.outputUrl("api"),
      { tries: 300, delayMs: 1000 },
    );

    // Dev identity: the function URL is served locally, not by AWS
    // (e.g. http://<id>.lambda-url.us-east-1.localhost:<port>/). The port
    // is whatever the emulator bound — never hard-code it, only the URL
    // captured from the CLI's stdout is authoritative.
    expect(new URL(api).hostname).toEndWith("localhost");
    expect(api).not.toContain("amazonaws.com");

    // Action data plane: the deploy-time SeedObject Action ran inside the
    // CLI's exec process and put/get an object through the S3 bindings.
    // The dummy account id proves the calls hit the emulator, not real
    // AWS; the roundtripped body proves the put actually landed.
    const seedAccount = await cli.pollUntil(
      "seedAccount in stack outputs",
      () => cli.outputValue("seedAccount"),
    );
    expect(seedAccount).toBe("000000000000");
    const seedText = await cli.pollUntil("seedText in stack outputs", () =>
      cli.outputValue("seedText"),
    );
    expect(seedText).toBe("seed-object-body-v1");

    // Marker + env: the function reads MY_VARIABLE through effect/Config.
    const home = (await (await fetchOk(api)).json()) as {
      marker: string;
      variable: string;
    };
    expect(home.marker).toBe("aws-dev-marker-v1");
    expect(home.variable).toBe("my-variable-abc123");

    // S3 binding: put/get roundtrip against the emulator.
    const s3 = (await (await fetchOk(new URL("/s3", api))).json()) as {
      text: string;
    };
    expect(s3.text).toBe("hello from s3");

    // DynamoDB binding: put/get roundtrip against the emulator.
    const dynamo = (await (await fetchOk(new URL("/dynamo", api))).json()) as {
      text: string | null;
    };
    expect(dynamo.text).toBe("hello from dynamo");

    // SQS: produce over the binding; floci's event-source-mapping poller
    // delivers to the consumer, which records into the table.
    const message = { id: crypto.randomUUID(), text: "hello from alchemy dev" };
    await fetchOk(new URL("/queue/send", api), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    const received = await cli.pollUntil(
      "queue message to be consumed",
      async () => {
        const res = await fetch(
          new URL(`/queue/messages?id=${message.id}`, api),
        );
        if (!res.ok) return undefined;
        const { body } = (await res.json()) as { body: string | null };
        return body ?? undefined;
      },
      { tries: 60, delayMs: 500 },
    );
    expect(JSON.parse(received)).toEqual(message);

    // SNS: publish over the binding. Delivery runs through the
    // lambda-protocol Subscription and the invoke Permission — the glue
    // resources that regressed by being created against real AWS with
    // emulator ARNs (InvalidParameterException: TopicArn / Function not
    // found). Consumption proves both were created on the emulator.
    const notification = { id: crypto.randomUUID(), text: "hello from sns" };
    await fetchOk(new URL("/topic/send", api), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notification),
    });
    const delivered = await cli.pollUntil(
      "topic notification to be consumed",
      async () => {
        const res = await fetch(
          new URL(`/topic/messages?id=${notification.id}`, api),
        );
        if (!res.ok) return undefined;
        const { body } = (await res.json()) as { body: string | null };
        return body ?? undefined;
      },
      { tries: 60, delayMs: 500 },
    );
    expect(JSON.parse(delivered)).toEqual(notification);

    // DynamoDB Streams: write a plain item; the table stream's
    // EventSourceMapping delivers the change record to
    // `consumeTableChanges`, which records it under `change:<id>`.
    const itemId = crypto.randomUUID();
    await fetchOk(new URL("/items", api), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: itemId }),
    });
    const change = await cli.pollUntil(
      "table change record to be consumed",
      async () => {
        const res = await fetch(new URL(`/changes?id=${itemId}`, api));
        if (!res.ok) return undefined;
        const { body } = (await res.json()) as { body: string | null };
        return body ?? undefined;
      },
      { tries: 60, delayMs: 500 },
    );
    expect(change).toBe("INSERT");

    // ── HOT RELOAD: rewrite src/marker.ts with the CLI still running. The
    // `--watch` exec child re-runs, the dev provider hot-swaps the function
    // code in floci, and the SAME url serves the new marker — no deploy ──
    fs.writeFileSync(
      markerPath,
      markerSource.replace("aws-dev-marker-v1", "aws-dev-marker-v2"),
    );
    await cli.pollUntil(
      "hot-swapped marker v2",
      async () => {
        try {
          const res = await fetch(api);
          if (!res.ok) return undefined;
          const { marker } = (await res.json()) as { marker: string };
          return marker === "aws-dev-marker-v2" ? marker : undefined;
        } catch {
          return undefined; // mid-swap
        }
      },
      { tries: 240, delayMs: 500 },
    );

    // Bindings survived the reload: the table still holds the consumed
    // message and the S3 roundtrip still works.
    const afterReload = (await (
      await fetchOk(new URL(`/queue/messages?id=${message.id}`, api))
    ).json()) as { body: string | null };
    expect(afterReload.body).toBe(JSON.stringify(message));
    const s3After = (await (await fetchOk(new URL("/s3", api))).json()) as {
      text: string;
    };
    expect(s3After.text).toBe("hello from s3");

    // Restore the marker — the swap back is itself a second hot reload,
    // and leaves the checked-in tree clean.
    fs.writeFileSync(markerPath, markerSource);
    await cli.pollUntil(
      "restored marker v1",
      async () => {
        try {
          const res = await fetch(api);
          if (!res.ok) return undefined;
          const { marker } = (await res.json()) as { marker: string };
          return marker === "aws-dev-marker-v1" ? marker : undefined;
        } catch {
          return undefined; // mid-swap
        }
      },
      { tries: 240, delayMs: 500 },
    );
  },
  { timeout: 600_000 },
);
